import OpenAI from "openai";

const SYSTEM_PROMPT = `You are a QA engineer. Given a user story or merge request (MR) description for a web feature, output a JSON array of test cases suitable for manual or automated web testing.

Each test case must have:
- id: short kebab-case id (e.g. "login-happy-path")
- title: one line summary
- scenario: what is being tested (1-2 sentences)
- steps: array of objects. REQUIRED keys per step: "action" (what to do) and "expectedResult" (what should happen). Optional: stepNumber (1-based), selector. Do not use only stepNumber without action text.
- priority: "high" | "medium" | "low"

Steps are executed automatically: the runner finds elements from your action and expectedResult text. Write clear, UI-oriented actions so the right elements can be discovered (e.g. "Fill email in login form", "Click Sign in", "Enter password"). You do not need to add selectors unless the page is very ambiguous.

Optional selector (only for ambiguous cases): use when the same action could match multiple elements. Formats:
- data-testid=value, id=value, name=value
- role=button name=Submit, label=Email
- CSS selector

You MUST output at least 3 test cases for reasonable coverage. One test case is not enough. Always include:
1. Happy path (valid inputs, success flow)
2. At least one negative case (e.g. invalid credentials, wrong format)
3. At least one validation/edge case (e.g. empty fields, error message shown)

Keep steps concrete; mention "login", "sign in", "newsletter", etc. in the action or expectedResult when the context matters.`;

function humanizeId(id) {
  if (!id || typeof id !== "string") return "";
  return id
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Map LLM step objects (many shapes) to { stepNumber, action, expectedResult, selector }. */
function normalizeStep(s, j) {
  if (typeof s === "string") {
    const t = s.trim();
    return { stepNumber: j + 1, action: t, expectedResult: "", selector: "" };
  }
  if (!s || typeof s !== "object") {
    return { stepNumber: j + 1, action: "", expectedResult: "", selector: "" };
  }
  const action =
    (typeof s.action === "string" && s.action.trim()) ||
    (typeof s.description === "string" && s.description.trim()) ||
    (typeof s.title === "string" && s.title.trim()) ||
    (typeof s.stepDescription === "string" && s.stepDescription.trim()) ||
    (typeof s.task === "string" && s.task.trim()) ||
    (typeof s.text === "string" && s.text.trim()) ||
    (typeof s.instruction === "string" && s.instruction.trim()) ||
    (typeof s.step === "string" && s.step.trim()) ||
    "";
  const expectedResult =
    (typeof s.expectedResult === "string" && s.expectedResult.trim()) ||
    (typeof s.expectResult === "string" && s.expectResult.trim()) ||
    (typeof s.expected === "string" && s.expected.trim()) ||
    (typeof s.verify === "string" && s.verify.trim()) ||
    (typeof s.assertion === "string" && s.assertion.trim()) ||
    (typeof s.outcome === "string" && s.outcome.trim()) ||
    (typeof s.result === "string" && s.result.trim()) ||
    "";
  return {
    stepNumber: s.stepNumber ?? s.step_no ?? s.number ?? j + 1,
    action,
    expectedResult,
    selector: s.selector || s.selectorHint || "",
  };
}

function normalizeTestCases(parsed) {
  const testCases = Array.isArray(parsed) ? parsed : (parsed?.testCases ?? []);
  return testCases.map((tc, i) => {
    const rawTitle = tc.title || tc.name || tc.summary || "";
    const firstStep = Array.isArray(tc.steps) ? tc.steps[0] : null;
    const firstAction =
      firstStep && typeof firstStep === "object"
        ? normalizeStep(firstStep, 0).action
        : typeof firstStep === "string"
          ? firstStep.trim()
          : "";
    const title =
      rawTitle.trim() ||
      humanizeId(tc.id) ||
      (tc.scenario && typeof tc.scenario === "string" ? tc.scenario.split(/[.!?]/)[0].trim().slice(0, 80) : "") ||
      firstAction ||
      `Test case ${i + 1}`;
    const steps = (Array.isArray(tc.steps) ? tc.steps : []).map((s, j) => normalizeStep(s, j));
    return {
      id: tc.id || `tc-${i + 1}`,
      title,
      scenario: tc.scenario || "",
      steps,
      priority: tc.priority || "medium",
    };
  });
}

/**
 * Repair common Ollama JSON mistakes: unquoted stepNumber and "action","val1","val2" (missing expectedResult key).
 */
function repairOllamaJson(str) {
  let s = str
    .replace(/([\s{,])stepNumber\s*:/g, '$1"stepNumber":')
    .replace(/([\s{,])priority\s*:/g, '$1"priority":');
  // Fix step objects like { "action","...","..." } or { stepNumber:1,"action","...","..." } -> "action":"...","expectedResult":"..."
  s = s.replace(/"action"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g, '"action":"$1","expectedResult":"$2"');
  // Ollama often omits the opening quote on the next key: "tab",expectedResult":" -> "tab","expectedResult":"
  s = s.replace(/,([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g, ',"$1":');
  return s;
}

/** Find index of closing `}` that matches `{` at openBraceIndex (string-aware). */
function findMatchingObjectEnd(s, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = openBraceIndex; i < s.length; i++) {
    const c = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escapeNext = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * When full JSON.parse fails (truncated first case, etc.), pull out each top-level test case object
 * by brace matching; skip broken objects via `},{"id":` boundaries.
 */
function salvageTestCasesFromRaw(raw) {
  const r = repairOllamaJson(raw.trim());
  const tcMatch = r.match(/"testCases"\s*:\s*\[/);
  if (!tcMatch) return [];
  let idx = tcMatch.index + tcMatch[0].length;
  const cases = [];
  while (idx < r.length) {
    const open = r.indexOf("{", idx);
    if (open === -1) break;
    const close = findMatchingObjectEnd(r, open);
    if (close === -1) {
      const nextTc = r.indexOf('},{"id":', open);
      if (nextTc === -1) break;
      idx = nextTc + 1;
      continue;
    }
    const chunk = r.slice(open, close + 1);
    try {
      const obj = JSON.parse(chunk);
      if (obj && typeof obj.id === "string") cases.push(obj);
    } catch {}
    idx = close + 1;
    while (idx < r.length && /[\s,\n\r]/.test(r[idx])) idx++;
  }
  return cases;
}

function extractJson(raw) {
  const trimmed = raw.trim();
  let parsed;
  const repaired = repairOllamaJson(trimmed);
  try {
    parsed = JSON.parse(repaired);
    if (Array.isArray(parsed)) return { testCases: parsed };
    return parsed;
  } catch {
    try {
      parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { testCases: parsed };
      return parsed;
    } catch {}
    // Ollama may truncate; try closing the JSON and parse again.
    // Include repair for truncated inside a string (e.g. "expectedResult":"text cut off)
    const suffixes = [
      "\n]}",
      "\n]",
      "]}",
      "]",
      "\"}]}]}\n",  // truncated inside "expectedResult": close string, step, steps, case, array, root
      "\"},]}]}\n",
    ];
    for (const suffix of suffixes) {
      try {
        parsed = JSON.parse(repairOllamaJson(trimmed + suffix));
        if (parsed && Array.isArray(parsed.testCases) && parsed.testCases.length > 0) {
          return parsed;
        }
        if (Array.isArray(parsed) && parsed.length > 0) return { testCases: parsed };
      } catch {}
    }
    // Try again after stripping trailing comma (Ollama sometimes outputs it)
    const trimmedNoTrailingComma = trimmed.replace(/,(\s*)$/, "$1");
    if (trimmedNoTrailingComma !== trimmed) {
      for (const suffix of ["\n]}", "\"}]}]}\n"]) {
        try {
          parsed = JSON.parse(repairOllamaJson(trimmedNoTrailingComma + suffix));
          if (parsed && Array.isArray(parsed.testCases) && parsed.testCases.length > 0) return parsed;
        } catch {}
      }
    }
    // Truncated mid-array: find last complete step object (has "expectedResult" or "action") and close
    const testCasesStart = repaired.indexOf('"testCases"');
    if (testCasesStart >= 0) {
      const arrayStart = repaired.indexOf("[", testCasesStart);
      if (arrayStart >= 0) {
        const afterBracket = repaired.slice(arrayStart + 1);
        const lastComplete = afterBracket.lastIndexOf("},");
        if (lastComplete >= 0) {
          try {
            const partial = repaired.slice(0, arrayStart + 1 + lastComplete + 1) + "]}\n";
            parsed = JSON.parse(partial);
            if (parsed && Array.isArray(parsed.testCases) && parsed.testCases.length > 0) return parsed;
          } catch {}
        }
        // Last resort: truncate at last complete step in first test case (steps array)
        const stepsStart = afterBracket.indexOf('"steps"');
        if (stepsStart >= 0) {
          const stepsArrStart = afterBracket.indexOf("[", stepsStart);
          if (stepsArrStart >= 0) {
            const stepsContent = afterBracket.slice(stepsArrStart + 1);
            const lastStepEnd = stepsContent.lastIndexOf("},");
            if (lastStepEnd >= 0) {
              try {
                const partial =
                  repaired.slice(0, arrayStart + 1 + stepsArrStart + 1 + lastStepEnd + 1) + "]}]}\n";
                parsed = JSON.parse(partial);
                if (parsed && Array.isArray(parsed.testCases) && parsed.testCases.length > 0) return parsed;
              } catch {}
            }
          }
        }
      }
    }
    const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlock) {
      try {
        parsed = JSON.parse(repairOllamaJson(jsonBlock[1].trim()));
        if (Array.isArray(parsed)) return { testCases: parsed };
        return parsed;
      } catch {}
    }
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        parsed = JSON.parse(repairOllamaJson(objectMatch[0]));
        if (Array.isArray(parsed)) return { testCases: parsed };
        return parsed;
      } catch {}
    }
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return { testCases: JSON.parse(repairOllamaJson(arrayMatch[0])) };
      } catch {}
    }
    const salvaged = salvageTestCasesFromRaw(trimmed);
    if (salvaged.length > 0) return { testCases: salvaged };
  }
  return { testCases: [] };
}

export async function generateTestCases(input) {
  const userMessage = `Story / MR:\n\n${input}\n\nRespond with a single JSON object only. Use strict JSON: all keys in double quotes. Format: {"testCases":[{"id":"...","title":"...","scenario":"...","steps":[{"stepNumber":1,"action":"...","expectedResult":"..."}],"priority":"high"}]}. No markdown or extra text.`;

  // 1) OpenAI (if API key is set)
  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error("Empty response from OpenAI");
    const testCases = normalizeTestCases(extractJson(raw));
    if (testCases.length === 0) throw new Error("LLM returned no test cases. The response may be malformed.");
    return testCases;
  }

  // 2) Ollama (local, no API key). Use 127.0.0.1 to avoid IPv6 localhost issues.
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";
  const ollamaModel = process.env.OLLAMA_MODEL || "llama3.2";
  const ollamaTimeout = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000; // 2 min (first run can be slow)
  // Omit max_tokens so Ollama uses default -1 (unlimited). Set OLLAMA_MAX_TOKENS to cap (e.g. 4096).
  const ollamaMaxTokens = process.env.OLLAMA_MAX_TOKENS ? Number(process.env.OLLAMA_MAX_TOKENS) : undefined;
  const maxAttempts = 3; // Retry when response is truncated or empty (Ollama can be slow or cut off mid-JSON)
  try {
    const openai = new OpenAI({
      apiKey: "ollama",
      baseURL: ollamaBase,
      timeout: ollamaTimeout,
    });
    let lastRaw = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const completion = await openai.chat.completions.create({
        model: ollamaModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...(ollamaMaxTokens != null && ollamaMaxTokens > 0 && { max_tokens: ollamaMaxTokens }),
      });
      const raw = completion.choices[0]?.message?.content?.trim();
      lastRaw = raw || lastRaw;
      if (raw) {
        const testCases = normalizeTestCases(extractJson(raw));
        if (testCases.length > 0) return testCases;
        if (attempt < maxAttempts) {
          console.warn("Ollama returned empty test cases (attempt " + attempt + "/" + maxAttempts + "), retrying…");
          await new Promise((r) => setTimeout(r, 1500)); // Brief delay before retry
        }
      }
    }
    if (lastRaw) {
      console.warn("Ollama returned empty test cases after " + maxAttempts + " attempts. Length:", lastRaw.length);
      console.warn("Raw (first 400):", lastRaw.slice(0, 400));
      console.warn("Raw (last 300):", lastRaw.slice(-300));
      throw new Error("LLM returned no test cases after " + maxAttempts + " tries. The response may be truncated or malformed. Try a shorter story or check the server log for the raw response.");
    }
    throw new Error("Ollama returned an empty response. Try again or use a different model.");
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("No LLM") || msg.includes("Ollama returned")) throw err;
    throw new Error(
      "Ollama error. Ensure Ollama is running (ollama run llama3.2) and reachable at " +
        ollamaBase +
        ". " +
        (msg ? msg : "")
    );
  }

  throw new Error("No LLM configured. Add OPENAI_API_KEY to .env or run Ollama (ollama run llama3.2).");
}
