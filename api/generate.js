import OpenAI from "openai";

const SYSTEM_PROMPT = `You are a QA engineer. Given a user story or merge request (MR) description for a web feature, output a JSON array of test cases suitable for manual or automated web testing.

Each test case must have:
- id: short kebab-case id (e.g. "login-happy-path")
- title: one line summary
- scenario: what is being tested (1-2 sentences)
- steps: array of { stepNumber, action, expectedResult }
- priority: "high" | "medium" | "low"

Include happy path, at least one negative/validation case, and edge cases where relevant. Focus on behavior a manual tester would verify. Keep steps concrete and UI-oriented (e.g. "Enter valid email in email field", "Click Submit button").`;

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
    return {
      id: tc.id || `tc-${i + 1}`,
      title,
      scenario: tc.scenario || "",
      steps: Array.isArray(tc.steps) ? tc.steps : [],
      priority: tc.priority || "medium",
    };
  });
}

function extractJson(raw) {
  const trimmed = raw.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { testCases: parsed };
    return parsed;
  } catch {
    const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlock) {
      try {
        parsed = JSON.parse(jsonBlock[1].trim());
        if (Array.isArray(parsed)) return { testCases: parsed };
        return parsed;
      } catch {}
    }
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        parsed = JSON.parse(objectMatch[0]);
        if (Array.isArray(parsed)) return { testCases: parsed };
        return parsed;
      } catch {}
    }
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return { testCases: JSON.parse(arrayMatch[0]) };
      } catch {}
    }
  }
  return { testCases: [] };
}

export async function generateTestCases(input) {
  const userMessage = `Story / MR:\n\n${input}\n\nRespond with a single JSON object: {"testCases": [ ... ]} where testCases is an array of test case objects. No markdown or extra text.`;

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
