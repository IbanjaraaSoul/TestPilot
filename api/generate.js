import OpenAI from "openai";

const SYSTEM_PROMPT = `You are a QA engineer. Given a user story or merge request (MR) description for a web feature, output a JSON array of test cases suitable for manual or automated web testing.

Each test case must have:
- id: short kebab-case id (e.g. "login-happy-path")
- title: one line summary
- scenario: what is being tested (1-2 sentences)
- steps: array of { stepNumber, action, expectedResult }; optionally add selector only when needed
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

function normalizeTestCases(parsed) {
  const testCases = Array.isArray(parsed) ? parsed : (parsed?.testCases ?? []);
  return testCases.map((tc, i) => {
    const rawTitle = tc.title || tc.name || tc.summary || "";
    const title =
      rawTitle.trim() ||
      humanizeId(tc.id) ||
      (tc.scenario && typeof tc.scenario === "string" ? tc.scenario.split(/[.!?]/)[0].trim().slice(0, 80) : "") ||
      (Array.isArray(tc.steps) && tc.steps[0]?.action ? tc.steps[0].action : "") ||
      `Test case ${i + 1}`;
    const steps = (Array.isArray(tc.steps) ? tc.steps : []).map((s, j) => ({
      stepNumber: s.stepNumber ?? j + 1,
      action: s.action ?? "",
      expectedResult: s.expectedResult ?? s.expectResult ?? "",
      selector: s.selector || s.selectorHint || "",
    }));
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
  return s;
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
    for (const suffix of ["\n]}", "\n]", "]}", "]"]) {
      try {
        parsed = JSON.parse(repairOllamaJson(trimmed + suffix));
        if (parsed && Array.isArray(parsed.testCases) && parsed.testCases.length > 0) {
          return parsed;
        }
        if (Array.isArray(parsed) && parsed.length > 0) return { testCases: parsed };
      } catch {}
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
  try {
    const openai = new OpenAI({
      apiKey: "ollama",
      baseURL: ollamaBase,
      timeout: ollamaTimeout,
    });
    const completion = await openai.chat.completions.create({
      model: ollamaModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      ...(ollamaMaxTokens != null && ollamaMaxTokens > 0 && { max_tokens: ollamaMaxTokens }),
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (raw) {
      const testCases = normalizeTestCases(extractJson(raw));
      if (testCases.length === 0) {
        console.warn("Ollama returned empty test cases. Raw response (first 500 chars):", raw.slice(0, 500));
        throw new Error("LLM returned no test cases. The response may be malformed. Check the terminal where 'npm start' runs for a snippet of the response.");
      }
      return testCases;
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
