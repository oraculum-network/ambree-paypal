// Round 8, D1: the guide's accept and decline forms answer the move they showed, never a later one.
// A page rendered for one proposal and posted after that proposal was answered (or replaced by another)
// changes nothing: the post is refused, and the page shown after it asks the current question.
// The stale page is the real one: its forms are read from renderOperatorPage's HTML and posted as they are.

import { describe, expect, it } from "vitest";
import { applyOperatorAction, renderOperatorPage } from "../src/operator/page.ts";
import { CONV, DATE, type World, kinds, paid, refundPosts } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const P1 = "2026-11-08";
const P2 = "2026-11-12";
const QUESTION = "Move the trip?";

/** The fields one form of a rendered page posts (its hidden inputs), found by its button's data-action. */
function formOf(html: string, action: string): URLSearchParams {
  const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]!).find((f) => f.includes(`data-action="${action}"`));
  if (!form) throw new Error(`no ${action} form on the page`);
  const fields = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.append(m[1]!, m[2]!);
  return fields;
}

/** The page as the guide sees it now. */
const page = (w: World, id: string, token: string) => renderOperatorPage(token, w.service.get(id)!);
const answered = (w: World, id: string) => kinds(w, id).filter((k) => k === "reschedule.accepted" || k === "reschedule.declined");
const answerEvents = (w: World) => w.channels.drain(CONV).filter((e) => e.type === "reschedule_answered");

/**
 * Paid on 2026-11-05; the agent proposes P1 and the guide's laptop renders that question. The guide then
 * accepts P1 on their phone (a fresh page), and the traveller asks for P2.
 */
async function staleLaptop() {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, P1);
  const laptop = page(w, id, token);
  expect(laptop).toContain(QUESTION);
  expect(laptop).toContain(P1);
  expect((await applyOperatorAction(w.service, token, formOf(page(w, id, token), "accept_reschedule"))).ok).toBe(true);
  expect(w.service.get(id)).toMatchObject({ date: P1, reschedule: { new_date: P1, status: "accepted" } });
  await w.service.proposeReschedule(id, P2);
  w.channels.drain(CONV);
  return { w, id, token, laptop };
}

describe("D1: a stale page's answer never answers a later move", () => {
  it("decline: refused, P2 stays proposed, nothing logged or announced, and no refund is unlocked", async () => {
    const { w, id, token, laptop } = await staleLaptop();
    const flash = await applyOperatorAction(w.service, token, formOf(laptop, "decline_reschedule"));
    expect(flash.ok).toBe(false);
    expect(flash.text).toMatch(/earlier|out of date|no longer/i);
    expect(w.service.get(id)).toMatchObject({ date: P1, reschedule: { new_date: P2, status: "proposed" } });
    expect(answered(w, id)).toEqual(["reschedule.accepted"]);
    expect(answerEvents(w)).toEqual([]);
    expect(await w.service.refundReason(w.service.get(id)!)).toBeUndefined();
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
    expect(refundPosts(w)).toBe(0);
    // The page shown after the post asks the current question.
    const now = page(w, id, token);
    expect(now).toContain(QUESTION);
    expect(now).toContain(`Yes, ${P2} works`);
  });

  it("accept: refused, the date stays on P1, and the agent isn't told the guide accepted P2", async () => {
    const { w, id, token, laptop } = await staleLaptop();
    const flash = await applyOperatorAction(w.service, token, formOf(laptop, "accept_reschedule"));
    expect(flash.ok).toBe(false);
    expect(w.service.get(id)).toMatchObject({ date: P1, reschedule: { new_date: P2, status: "proposed" } });
    expect(answered(w, id)).toEqual(["reschedule.accepted"]);
    expect(answerEvents(w)).toEqual([]);
  });

  it("the current page's forms still answer the current move", async () => {
    const { w, id, token } = await staleLaptop();
    expect((await applyOperatorAction(w.service, token, formOf(page(w, id, token), "decline_reschedule"))).ok).toBe(true);
    expect(w.service.get(id)).toMatchObject({ date: P1, reschedule: { new_date: P2, status: "declined" } });
    expect(answerEvents(w).map((e) => e.text)).toEqual([expect.stringContaining(`can't do ${P2}`)]);
    expect(await w.service.refundReason(w.service.get(id)!)).toBe("the guide declined the reschedule");
  });

  it("a page asking the same date again is a new question: the old page's 'yes' doesn't answer it", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, P1);
    const laptop = page(w, id, token);
    expect((await applyOperatorAction(w.service, token, formOf(page(w, id, token), "decline_reschedule"))).ok).toBe(true);
    // The agent asks for the same day once more (allowed: the last move was declined, nothing refunded yet).
    await w.service.proposeReschedule(id, P1);
    expect((await applyOperatorAction(w.service, token, formOf(laptop, "accept_reschedule"))).ok).toBe(false);
    expect(w.service.get(id)).toMatchObject({ date: DATE, reschedule: { new_date: P1, status: "proposed" } });
    expect(answered(w, id)).toEqual(["reschedule.declined"]);
  });

  it("a post that names no move (a page from before this check) is refused too", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, P1);
    for (const action of ["accept_reschedule", "decline_reschedule"]) {
      expect((await applyOperatorAction(w.service, token, new URLSearchParams({ action }))).ok, action).toBe(false);
    }
    expect(w.service.get(id)).toMatchObject({ date: DATE, reschedule: { new_date: P1, status: "proposed" } });
    expect(answered(w, id)).toEqual([]);
  });
});
