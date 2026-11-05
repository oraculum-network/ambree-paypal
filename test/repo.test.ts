import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_API_BASE } from "../src/paypal/sandbox.ts";
import { TOOL_NAMES } from "../src/tools/registry.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("repo hygiene", () => {
  it("is MIT, by the Ambree authors", () => {
    expect(read("LICENSE")).toContain("MIT License");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 The Ambree authors");
    expect(JSON.parse(read("package.json")).license).toBe("MIT");
  });

  it("the README names every tool, the spike command and the built-during note", () => {
    const readme = read("README.md");
    for (const t of TOOL_NAMES) expect(readme).toContain(`\`${t}\``);
    expect(readme).toContain("node scripts/spike.ts --payee-merchant-id");
    expect(readme).toContain("node scripts/live-check.ts --base http://127.0.0.1:8080");
    expect(readme).toContain("Built during the hackathon");
  });

  it("no live PayPal host appears in source", () => {
    const files = ["src/paypal/client.ts", "src/paypal/sandbox.ts", "src/config.ts", "scripts/spike.ts", "scripts/live-check.ts", "src/app.ts"];
    for (const f of files) expect(read(f)).not.toMatch(/api-m\.paypal\.com|api\.paypal\.com/);
    expect(SANDBOX_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });

  it("the k8s manifests match the host's paypal block: credentials from Secret paypal-secrets, sqlite on paypal-data", () => {
    const d = read("deploy/k8s/deployment.yaml");
    // The eight keys of the hand-made Secret, each required (no optional: the pod waits for the Secret). Since
    // 3 Nov (DESIGN.md §21) the guide's own REST app and its webhook id are three of them.
    const keys = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_GUIDE_CLIENT_ID", "PAYPAL_GUIDE_CLIENT_SECRET", "PAYPAL_GUIDE_WEBHOOK_ID", "LLM_API_KEY", "MCP_DEMO_PASSCODE"];
    for (const k of keys) {
      expect(d).toContain(`- name: ${k}\n              valueFrom: { secretKeyRef: { name: paypal-secrets, key: ${k} } }`);
    }
    expect(d.match(/secretKeyRef/g)).toHaveLength(keys.length);
    // DEPLOY.md names the same keys for the Secret, and the guide's webhook URL.
    const deploy = read("DEPLOY.md");
    for (const k of keys) expect(deploy).toContain(`\`${k}\``);
    expect(deploy).toContain("https://paypal.ambree.ai/webhooks/paypal/guide");
    expect(d).not.toMatch(/optional:|paypal-sandbox|envFrom/);
    // The safe default: the operator check runs (never config-only), and no live PayPal base URL.
    expect(d).not.toMatch(/- name: PAYPAL_OPERATOR_IDENTITY|- name: PAYPAL_BASE_URL|_EMAIL/);
    expect(d).toContain("claimName: paypal-data");
    expect(d).toContain("mountPath: /data");
    expect(d).toContain("value: /data/ambree.sqlite");
    expect(d).toContain("type: Recreate");
    expect(d).toContain("priorityClassName: paypal-low");
    expect(d).toContain("value: https://paypal.ambree.ai");
    expect(read("deploy/k8s/kustomization.yaml")).toContain("namespace: paypal");
    expect(read("deploy/k8s/ingress.yaml")).toContain("host: paypal.ambree.ai");
  });
});
