# TestPilot

**AI-powered test pilot:** paste a story or MR → AI generates test cases → run them in the browser (Playwright). Built for delta testing—new tests that come with every story.

## What this demos

1. **Input**: Story or MR description (e.g. “User can log in with email and password”).
2. **Generate**: AI suggests test cases (scenarios, steps, expected results). The UI shows each case with its **steps**; for good coverage the AI is prompted to output at least 3 cases (happy path, negative, validation).
3. **Execute**: Run one test (**Run first test**) or **Run all tests** against a given URL (Playwright). Step-by-step results and a summary (X passed, Y failed) are shown.
4. **Auto mode**: Check **Auto mode: generate then run all tests** and click **Generate test cases** — after generation, all tests run automatically against the Base URL (no extra click).

## Quick start

### 1. Install and env

```bash
npm install
cp .env.example .env
```

**AI for test case generation (required — pick one):**

- **Ollama (free, no API key)**  
  1. Install [Ollama](https://ollama.com) and run: `ollama run llama3.2` (or `mistral` / `llama3.1`).  
  2. Leave `OPENAI_API_KEY` unset. The app uses `http://127.0.0.1:11434/v1` by default.  
  3. Optional in `.env`: `OLLAMA_BASE_URL`, `OLLAMA_MODEL=llama3.2`, `OLLAMA_TIMEOUT_MS=120000`.  
  4. **Token limit**: By default Ollama uses unlimited output. To cap length, set `OLLAMA_MAX_TOKENS=4096` (or any number) in `.env`.

- **OpenAI**  
  Set `OPENAI_API_KEY=sk-...` in `.env`. Uses `gpt-4o-mini`.

If neither is set (and Ollama isn’t running), generation will fail; set up OpenAI or run Ollama as above.

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

1. In the textarea, paste a story. Example:  
   **"As a user I want to log in with email and password. Acceptance criteria: Email and password fields, Submit button, show welcome message on success, show error on invalid credentials."**  
   For a flow with two forms (newsletter + login), see **[STORY-COMPLEX-FLOW.txt](STORY-COMPLEX-FLOW.txt)**.
2. Optionally check **Auto mode: generate then run all tests** so generation is followed by running all tests automatically.
3. Click **Generate test cases**.
4. Review the generated test cases (titles, steps, and expected results are shown). Base URL is pre-filled with **http://localhost:3456**; you can edit it.
5. If you didn’t use Auto mode: click **Run first test** (single test) or **Run all tests** (every generated case in sequence). A **Chromium window** opens so you can watch the steps. **Important:** The browser opens on the machine where the server is running — start the server from a **local terminal** (e.g. Terminal.app), not from SSH. If you don’t see the window, check other desktops or use Cmd+Tab. The UI shows **Passed** / **Failed** with step logs; **Run all tests** shows a summary (e.g. 3 passed, 0 failed).

## Locator discovery (no selectors required)

The executor **finds elements from step text** when you don’t provide selectors:

- **Clicks**: Phrases like “Click Sign in” or “Submit the form” are used to find the button or link by role and name.
- **Email / password**: If the step mentions “login” or “sign in”, the executor prefers inputs inside a **login form** (e.g. form with a password field or “login” in id/name/class), so the right fields are used even when the page has multiple forms (e.g. newsletter + login).

You can still add **optional selectors** per step for ambiguous pages; see **Selectors for complex flows** below.

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for diagrams: high-level flow, component view, sequence diagrams (generate test cases / run test), and deployment view. The doc uses [Mermaid](https://mermaid.js.org/) — render it in VS Code (Markdown Preview), GitHub, or any Mermaid-supported viewer.

## Project layout

- `server.js` – Express server and routes.
- `api/generate.js` – Calls OpenAI or Ollama to produce test cases from story/MR text (prompts for ≥3 cases, repairs common Ollama JSON issues).
- `api/execute.js` – Runs one test case with Playwright; discovers locators from step text or uses optional selectors.
- `public/index.html` – UI: story input, **Generate test cases**, **Auto mode** checkbox, test case list (with steps), default Base URL, **Run first test** and **Run all tests**.
- `demo-target/` – Minimal login page used as the “app under test”.
- `demo-target-server.js` – Serves the demo target on port 3456.

## Limitations

- **Execution** uses automatic locator discovery (role, text, form context) by default. For **complex flows**, the LLM can add optional **selectors** per step; the executor uses them when present.
- **Run first test** runs one case; **Run all tests** runs every generated case in sequence and shows a summary. **Auto mode** runs all tests right after generation.
- **AI**: requires OpenAI (API key) or **Ollama** (local, free). No mock fallback.

## Selectors for complex flows

When you need precise targeting (e.g. two email fields on the same page), the LLM can add an optional **selector** to a step. Supported formats:

| Format | Example | Use case |
|--------|---------|----------|
| `data-testid=value` | `data-testid=submit-btn` | Elements with test IDs |
| `id=value` or `#value` | `#email`, `id=email` | By element id |
| `name=value` | `name=email` | Form inputs by name |
| `role=role name=Name` | `role=button name=Submit` | By ARIA role + name |
| `label=Label text` | `label=Email` | Inputs by associated label |
| CSS selector | `.form .submit` | Any valid CSS selector |

You can also paste or edit test cases that include a `selector` field per step.

## Possible next steps

- Add MR/diff input (e.g. paste diff or link to MR).
- Generate Playwright scripts per test case and save to repo.
- Richer step-to-action mapping or page snapshot for selector inference.
