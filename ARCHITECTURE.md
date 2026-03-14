# TestPilot – Architecture

## High-level flow

```mermaid
flowchart LR
    subgraph User
        Browser["Browser\n(TestPilot UI)"]
    end

    subgraph POC["TestPilot Server (Node/Express :3000)"]
        Static["Static files\n(public/)"]
        API["API routes"]
        Gen["generate-test-cases"]
        Exec["execute"]
    end

    subgraph AI["AI / Test design"]
        OpenAI["OpenAI\n(gpt-4o-mini)"]
        Ollama["Ollama\n(local)"]
        Mock["Mock cases\n(no key)"]
    end

    subgraph Execution["Test execution"]
        PW["Playwright"]
        Chromium["Chromium\n(visible window)"]
    end

    subgraph Target["App under test"]
        Demo["Demo target\n(Express :3456)"]
    end

    Browser -->|"1. Load UI"| Static
    Browser -->|"2. POST story"| Gen
    Gen --> OpenAI
    Gen --> Ollama
    Gen --> Mock
    Gen -->|"test cases JSON"| Browser
    Browser -->|"3. POST test + URL"| Exec
    Exec --> PW
    PW --> Chromium
    Chromium -->|"4. Navigate, fill, click"| Demo
    PW -->|"result + step logs"| Exec
    Exec -->|"Passed/Failed"| Browser
```

## Component diagram

```mermaid
C4Context
    title System Context – TestPilot

    Person(user, "Tester", "Pastes story, runs tests")
    System(poc, "TestPilot", "Story → test cases → run test")
    System_Ext(openai, "OpenAI API", "Optional: generate test cases")
    System_Ext(ollama, "Ollama", "Optional: local LLM")
    System(demo, "Demo target", "Login page under test")

    Rel(user, poc, "Uses")
    Rel(poc, openai, "Calls if API key set")
    Rel(poc, ollama, "Calls if no key, Ollama running")
    Rel(poc, demo, "Playwright drives browser to")
```

## Sequence: Generate test cases

```mermaid
sequenceDiagram
    participant U as Browser (user)
    participant S as TestPilot Server
    participant AI as OpenAI / Ollama / Mock

    U->>S: POST /api/generate-test-cases { story }
    S->>AI: Request test cases
    AI->>S: JSON test cases
    S->>U: { testCases: [...] }
```

## Sequence: Run first test

```mermaid
sequenceDiagram
    participant U as Browser (user)
    participant S as TestPilot Server
    participant PW as Playwright
    participant C as Chromium
    participant D as Demo target (:3456)

    U->>S: POST /api/execute { testCase, baseUrl }
    S->>PW: Launch browser (headed)
    PW->>C: Open window
    S->>C: goto(baseUrl)
    C->>D: GET /
    D->>C: Login page
    S->>C: fill email, fill password, click Submit
    C->>D: Form submit
    D->>C: Welcome message
    S->>PW: Close browser
    S->>U: { passed, stepLogs }
```

## Deployment view

```mermaid
flowchart TB
    subgraph "Your machine"
        A["Terminal 1: npm run demo-target"]
        B["Terminal 2: npm start"]
        C["Browser: localhost:3000"]
    end

    A -->|"Serves"| D["localhost:3456\n(demo login page)"]
    B -->|"Serves + API"| E["localhost:3000\n(TestPilot UI + /api/*)"]
    C -->|"HTTP"| E
    E -->|"Optional"| F["OpenAI API"]
    E -->|"Optional"| G["Ollama localhost:11434"]
    E -->|"Playwright"| H["Chromium window"]
    H -->|"HTTP"| D
```

## Key files

| Component        | Path                    | Role                                      |
|-----------------|-------------------------|-------------------------------------------|
| TestPilot server | `server.js`             | Express, static files, API routes          |
| Generate API    | `api/generate.js`       | OpenAI / Ollama / mock → test cases        |
| Execute API     | `api/execute.js`        | Playwright → steps against baseUrl        |
| Frontend        | `public/index.html`     | Story input, test list, run, results      |
| Demo target     | `demo-target/`          | Minimal login page (app under test)       |
| Demo server     | `demo-target-server.js` | Serves demo-target on :3456               |
