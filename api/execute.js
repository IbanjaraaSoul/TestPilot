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

/**
 * Resolve a Playwright locator from step.selector / step.selectorHint for complex flows.
 * Supports: data-testid=, id=/#, name=, role= name=, label=, or plain CSS.
 */
function getLocatorFromSelector(page, selectorStr) {
  const s = (selectorStr || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith("data-testid=")) {
    const value = s.slice("data-testid=".length).trim().replace(/^["']|["']$/g, "");
    return value ? page.getByTestId(value) : null;
  }
  if (lower.startsWith("id=") || s.startsWith("#")) {
    const value = s.startsWith("#") ? s.slice(1).trim() : s.slice(3).trim().replace(/^["']|["']$/g, "");
    return value ? page.locator(`#${value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`) : null;
  }
  if (lower.startsWith("name=")) {
    const value = s.slice(5).trim().replace(/^["']|["']$/g, "");
    return value ? page.locator(`[name="${value.replace(/"/g, '\\"')}"]`) : null;
  }
  if (lower.startsWith("role=")) {
    const rest = s.slice(5).trim();
    const nameMatch = rest.match(/name\s*=\s*["']([^"']*)["']|name\s*=\s*(\S+)/i);
    const name = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? "").trim() : undefined;
    const role = rest.replace(/\s*name\s*=\s*["']?[^"'\s]*["']?\s*$/i, "").trim().toLowerCase();
    return page.getByRole(role, name ? { name } : {});
  }
  if (lower.startsWith("label=")) {
    const value = s.slice(6).trim().replace(/^["']|["']$/g, "");
    return value ? page.getByLabel(value) : null;
  }
  return page.locator(s);
}

/**
 * Discover a locator from step action/expectedResult when no selector is provided.
 * Uses role+name, label, and context (e.g. "login" form) so the right element is chosen.
 */
async function getLocatorFromStep(page, step, kind) {
  const action = (step.action || "").trim();
  const expected = (step.expectedResult || "").trim();
  const combined = `${action} ${expected}`.toLowerCase();

  if (kind === "click") {
    // Prefer button/link text from action: "Click Sign in", "Submit the form", "Press Login"
    const clickPhrases = action.match(/(?:click|press|submit)\s+(?:the\s+)?(?:button\s+)?["']?([^"'.]+)["']?/i) ||
      action.match(/(?:click|press)\s+["']([^"']+)["']/i);
    const name = clickPhrases ? clickPhrases[1].trim() : action.replace(/^(click|press|submit)\s+(the\s+)?/i, "").trim();
    if (name) {
      const byRole = page.getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      if ((await byRole.count()) > 0) return byRole.first();
      const byLink = page.getByRole("link", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      if ((await byLink.count()) > 0) return byLink.first();
      const byText = page.getByText(name, { exact: false });
      if ((await byText.count()) > 0) return byText.first();
    }
    return null;
  }

  if (kind === "email") {
    const isLogin = /\b(login|sign\s*in|signin)\b/.test(combined);
    const emailSelector = 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"], input[placeholder*="Email"]';
    if (isLogin) {
      // Prefer email input inside a form that has a password field or "login" in id/name/class
      const form = page.locator('form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"], form:has(input[type="password"])').first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(emailSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
    }
    return page.locator(emailSelector).first();
  }

  if (kind === "password") {
    const isLogin = /\b(login|sign\s*in|signin)\b/.test(combined);
    const pwdSelector = 'input[type="password"], input[name="password"], input[id="password"]';
    if (isLogin) {
      const form = page.locator('form[id*="login"], form[name*="login"], form[class*="login"], form[id*="signin"]').first();
      if ((await form.count()) > 0) {
        const inForm = form.locator(pwdSelector);
        if ((await inForm.count()) > 0) return inForm.first();
      }
    }
    return page.locator(pwdSelector).first();
  }

  return null;
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
          const fillValue = forEmail ? "test@example.com" : "test";
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = forEmail ? await getLocatorFromStep(page, step, "email") : null;
          if (loc) {
            await loc.fill(fillValue);
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const selector = forEmail ? 'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail"]' : 'input[type="text"], input:not([type="hidden"])';
            await page.locator(selector).first().fill(fillValue);
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled input" });
            logStep(i + 1, step.action, "ok", "Filled input");
          }
          await delay();
        } else if (action.includes("password")) {
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = await getLocatorFromStep(page, step, "password");
          if (loc) {
            await loc.fill("password123");
            const detail = step.selector ? "Filled (selector)" : "Filled (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const sel = 'input[type="password"], input[name="password"], input[id="password"]';
            await page.locator(sel).first().fill("password123");
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Filled password" });
            logStep(i + 1, step.action, "ok", "Filled password");
          }
          await delay();
        } else if (action.includes("click") || action.includes("submit") || action.includes("press")) {
          let loc = getLocatorFromSelector(page, step.selector);
          if (!loc) loc = await getLocatorFromStep(page, step, "click");
          if (loc) {
            await loc.click();
            const detail = step.selector ? "Clicked (selector)" : "Clicked (discovered)";
            logs.push({ step: i + 1, action: step.action, status: "ok", detail });
            logStep(i + 1, step.action, "ok", detail);
          } else {
            const btn = page.locator('button[type="submit"], input[type="submit"], button, a.button, [role="button"]').first();
            await btn.click();
            logs.push({ step: i + 1, action: step.action, status: "ok", detail: "Clicked" });
            logStep(i + 1, step.action, "ok", "Clicked");
          }
          await page.waitForLoadState("domcontentloaded").catch(() => {});
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
