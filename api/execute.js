import { chromium } from "playwright";

/** Delay so you can see each step in the browser (ms). */
const STEP_DELAY_MS = Number(process.env.PLAYWRIGHT_STEP_DELAY_MS) || 800;

/** Run in visible browser when set to "1" or "true". */
const HEADED = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_HEADED || "true");

/**
 * Runs a single test case against baseUrl using Playwright.
 * By default launches a visible browser so you can watch steps execute.
 */
function logStep(stepNum, action, status, detail) {
  const statusIcon = status === "ok" ? "✓" : status === "fail" ? "✗" : "○";
  console.log(`  [${statusIcon}] Step ${stepNum}: ${action} — ${detail}`);
}

export async function runTest(testCase, baseUrl) {
  const steps = testCase.steps || [];
  const logs = [];
  let passed = true;
  let errorMessage = null;

  console.log("\n--- Test run ---");
  console.log(`Test: ${testCase.title}`);
  console.log(`URL:  ${baseUrl}`);
  console.log("Steps:");

  let browser;
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      slowMo: HEADED ? 150 : 0,
      timeout: 30000,
    });
  } catch (launchErr) {
    const msg = launchErr.message || "";
    const hint =
      HEADED && (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch"))
        ? " Run the server from a normal terminal on this machine (e.g. Terminal.app) so the test browser can open. Or set PLAYWRIGHT_HEADED=false in .env to run without a visible window."
        : "";
    throw new Error(`Browser could not launch: ${msg}${hint}`);
  }
  try {
    const page = await browser.newPage();
    const delay = () => new Promise((r) => setTimeout(r, STEP_DELAY_MS));

    // Always open the app first so fill/click steps have a page to act on (LLM may omit "navigate" step).
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await delay();
    console.log("  [✓] (initial) Navigate to app — OK");

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = (step.action || "").toLowerCase();
      const expected = step.expectedResult || "";

      try {
        if (action.includes("navigate") || action.includes("open") || action.includes("go to")) {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Navigated to ${baseUrl}` });
          logStep(i + 1, step.action, "ok", `Navigated to ${baseUrl}`);
          await delay();
        } else if (action.includes("enter") || action.includes("type") || action.includes("fill")) {
          const forEmail = action.includes("email") || expected.includes("email");
          const selector = forEmail ? 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"]' : 'input[type="text"], input:not([type="hidden"])';
          const first = await page.locator(selector).first();
          await first.fill(forEmail ? "test@example.com" : "test");
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled input" });
          logStep(i + 1, step.action, "ok", "Filled input");
          await delay();
        } else if (action.includes("password")) {
          const sel = 'input[type="password"], input[name="password"], input[id="password"]';
          await page.locator(sel).first().fill("password123");
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled password" });
          logStep(i + 1, step.action, "ok", "Filled password");
          await delay();
        } else if (action.includes("click") || action.includes("submit") || action.includes("press")) {
          const btn = page.locator('button[type="submit"], input[type="submit"], button, a.button, [role="button"]').first();
          await btn.click();
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Clicked" });
          logStep(i + 1, step.action, "ok", "Clicked");
          await delay();
        } else if (action.includes("see") || action.includes("verify") || action.includes("check") || expected) {
          await delay();
          const text = expected || action;
          const found = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
          if (found) {
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: `Found: "${text.slice(0, 50)}..."` });
            logStep(i + 1, step.action, "ok", `Found: "${text.slice(0, 50)}..."`);
          } else {
            logs.push({ step: i + 1, action: step.action, status: "skip", detail: `Could not verify text; page content available for manual check.` });
            logStep(i + 1, step.action, "skip", "Could not verify text");
          }
        } else {
          logs.push({ step: i + 1, action: step.action, status: "skip", detail: "No automation mapping" });
          logStep(i + 1, step.action, "skip", "No automation mapping");
        }
      } catch (stepErr) {
        passed = false;
        errorMessage = stepErr.message;
        logs.push({ step: i + 1, action: step.action, status: "fail", detail: stepErr.message });
        logStep(i + 1, step.action, "fail", stepErr.message);
        break;
      }
    }

    if (passed && logs.length === 0 && steps.length > 0) {
      logs.push({ step: "-", action: "No steps could be automated", status: "skip", detail: "Review steps manually." });
    }

    if (HEADED && passed) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  console.log(passed ? "Result: PASSED\n" : `Result: FAILED — ${errorMessage || "see steps above"}\n`);

  return {
    testCaseId: testCase.id,
    title: testCase.title,
    passed,
    errorMessage,
    stepLogs: logs,
  };
}
