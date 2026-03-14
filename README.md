# TestPilot

**AI-powered test pilot:** paste a story or MR → AI generates test cases → run them in the browser (Playwright). Built for delta testing—new tests that come with every story.

## What this demos

1. **Input**: Story or MR description (e.g. “User can log in with email and password”).
2. **Generate**: AI suggests test cases (scenarios, steps, expected results).
3. **Execute**: Run one test (**Run first test**) or **Run all tests** against a given URL (Playwright); step-by-step results and a summary (X passed, Y failed) are shown.

## Quick start

### 1. Install and env

```bash
npm install
cp .env.example .env
```

**AI for test case generation (required — pick one):**

- **Ollama (free, no API key)**  
  1. Install [Ollama](https://ollama.com) and run: `ollama run llama3.2` (or `mistral` / `llama3.1`).  
  2. Leave `OPENAI_API_KEY` unset. The app will use `http://localhost:11434/v1` by default.  
  3. Optional in `.env`: `OLLAMA_BASE_URL=http://localhost:11434/v1`, `OLLAMA_MODEL=llama3.2`.

- **OpenAI**  
  Set `OPENAI_API_KEY=sk-...` in `.env`. Uses `gpt-4o-mini`.

- If neither is available,  
  If both are missing (and Ollama isn’t running), you must set up OpenAI or run Ollama (see above).

### 2. Install Playwright browsers (one-time)

```bash
npx playwright install chromium
```

### 3. Run the demo target app (optional but recommended)

In one terminal:

```bash
npm run demo-target
```

This serves a minimal login page at **http://localhost:3456**.

### 4. Run the server

In another terminal:

```bash
npm start
```

Open **http://localhost:3000**.

### 5. Try the flow

1. In the textarea, paste a story (see **[STORY-COMPLEX-FLOW.txt](STORY-COMPLEX-FLOW.txt)** for a complex flow with selectors). Simple example:  
   **"As a user I want to log in with email and password. Acceptance criteria: Email and password fields, Submit button, show welcome message on success, show error on invalid credentials."**
2. Click **Generate test cases**.
3. Review the generated test cases.
4. In **Base URL** enter `http://localhost:3456` (if the demo target is running).
5. Click **Run first test** (single test) or **Run all tests** (every generated case in sequence). A **Chromium window** opens for each run so you can watch the steps (navigate → fill email/password → click Submit). **Important:** The browser opens on the machine where the server is running — start the server from a **local terminal** (e.g. Terminal.app), not from SSH or a headless environment. If you don’t see the window, check other desktops or use Cmd+Tab. When a run finishes, the UI shows **Passed** or **Failed** with step-by-step logs; **Run all tests** shows a summary (e.g. 6 passed, 0 failed) plus each result.

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for diagrams: high-level flow, component view, sequence diagrams (generate test cases / run test), and deployment view. The doc uses [Mermaid](https://mermaid.js.org/) — render it in VS Code (Markdown Preview), GitHub, or any Mermaid-supported viewer.

## Project layout

- `server.js` – Express server and routes.
- `api/generate.js` – Calls OpenAI to produce test cases from story/MR text.
- `api/execute.js` – Runs one test case with Playwright (navigate, fill, click, basic checks).
- `public/index.html` – UI: story input, test case list, **Run first test** and **Run all tests**.
- `demo-target/` – Minimal login page used as the “app under test”.
- `demo-target-server.js` – Serves the demo target on port 3456.

## Limitations

- **Execution** uses heuristics by default (e.g. “enter email” → first email input). For **complex flows**, the LLM can add optional **selectors** per step (`data-testid=`, `id=`, `name=`, `role= name=`, `label=`, or CSS); the executor uses them when present for precise targeting.
- **Run first test** runs one case; **Run all tests** runs every generated case in sequence and shows a summary.
- **AI**: requires OpenAI (API key) or **Ollama** (local, free). No mock fallback.

## Selectors for complex flows

When the LLM adds an optional **selector** to a step, the executor uses it for that step. Supported formats:

| Format | Example | Use case |
|--------|---------|----------|
| `data-testid=value` | `data-testid=submit-btn` | Elements with test IDs |
| `id=value` or `#value` | `#email`, `id=email` | By element id |
| `name=value` | `name=email` | Form inputs by name |
| `role=role name=Name` | `role=button name=Submit` | By ARIA role + name |
| `label=Label text` | `label=Email` | Inputs by associated label |
| CSS selector | `.form .submit` | Any valid CSS selector |

The LLM is prompted to add selectors when multiple similar elements exist or for complex layouts. You can also paste test cases that include a `selector` field per step (e.g. from a hand-edited export).

## Possible next steps

- Add MR/diff input (e.g. paste diff or link to MR).
- Generate Playwright scripts per test case and save to repo.
- Richer step-to-action mapping or selector hints from the story.
