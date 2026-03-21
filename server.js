import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { generateTestCases } from "./api/generate.js";
import { runTest } from "./api/execute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/generate-test-cases", async (req, res) => {
  try {
    const { story, mrDescription, diffSnippet } = req.body;
    const input = [story, mrDescription, diffSnippet].filter(Boolean).join("\n\n");
    if (!input.trim()) {
      return res.status(400).json({ error: "Provide at least story, mrDescription, or diffSnippet." });
    }
    console.log("Generate test cases: request received (using " + (process.env.OPENAI_API_KEY ? "OpenAI" : "Ollama") + ")...");
    const testCases = await generateTestCases(input);
    console.log("Generate test cases: OK,", testCases.length, "cases");
    return res.json({ testCases });
  } catch (err) {
    console.error("Generate test cases error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to generate test cases." });
  }
});

app.post("/api/execute", async (req, res) => {
  try {
    const { testCase, baseUrl } = req.body;
    if (!testCase || !baseUrl) {
      return res.status(400).json({ error: "Provide testCase and baseUrl." });
    }
    const result = await runTest(testCase, baseUrl);
    return res.json(result);
  } catch (err) {
    console.error("Execute test error:", err);
    return res.status(500).json({ error: err.message || "Test execution failed." });
  }
});

/** NDJSON stream: one JSON object per line for live progress, final line `{ type: "done", result }` or `{ type: "error", error }`. */
app.post("/api/execute-stream", async (req, res) => {
  try {
    const { testCase, baseUrl } = req.body;
    if (!testCase || !baseUrl) {
      return res.status(400).json({ error: "Provide testCase and baseUrl." });
    }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    const write = (obj) => {
      res.write(JSON.stringify(obj) + "\n");
    };
    const result = await runTest(testCase, baseUrl, { onProgress: write });
    write({ type: "done", result });
    res.end();
  } catch (err) {
    console.error("Execute stream error:", err);
    try {
      res.write(JSON.stringify({ type: "error", error: err.message || "Test execution failed." }) + "\n");
      res.end();
    } catch {
      /* response may be closed */
    }
  }
});

app.listen(PORT, () => {
  console.log(`TestPilot running at http://localhost:${PORT}`);
});
