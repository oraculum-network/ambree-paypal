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
    expect(readme).toContain("Built during the hackathon");
  });

  it("no live PayPal host appears in source", () => {
    const files = ["src/paypal/client.ts", "src/paypal/sandbox.ts", "src/config.ts", "scripts/spike.ts", "src/app.ts"];
    for (const f of files) expect(read(f)).not.toMatch(/api-m\.paypal\.com|api\.paypal\.com/);
    expect(SANDBOX_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });

  it("the k8s draft reads every credential from optional Secrets", () => {
    const d = read("deploy/k8s/deployment.yaml");
    for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "LLM_API_KEY"]) expect(d).toMatch(new RegExp(`${k}, optional: true`));
    expect(d).toContain("value: https://paypal.ambree.ai");
    expect(read("deploy/k8s/ingress.yaml")).toContain("host: paypal.ambree.ai");
  });
});
