import { describe, it, expect, beforeEach } from "vitest";
import { Engine } from "../../../src/core/services/engine.js";
import { DoctorRelay } from "../../../src/core/services/relay/index.js";
import { loadConfig } from "../../../src/config/load.js";
import { FakeLlm, FixedClock, InMemoryAudit, InMemoryConversationRepo, InMemoryDoctorState, InMemoryOutbox, noLock } from "../../support/fakes.js";

const PATIENT = "6591234567";
const DOCTOR = "+6590000001";
const DOCTOR_B = "+6590000002";
let repo: InMemoryConversationRepo, outbox: InMemoryOutbox, audit: InMemoryAudit, llm: FakeLlm, clock: FixedClock, engine: Engine, relay: DoctorRelay, doctors: InMemoryDoctorState;

function msg(text: string, id = `wamid.${Math.random()}`) {
  return { externalId: id, from: PATIENT, text, at: clock.now() };
}

beforeEach(() => {
  repo = new InMemoryConversationRepo(); outbox = new InMemoryOutbox(); audit = new InMemoryAudit(); doctors = new InMemoryDoctorState();
  llm = new FakeLlm(); clock = new FixedClock(new Date("2026-09-15T04:00:00Z"));
  const config = loadConfig("test/fixtures/config");
  const seq = ["P7K", "Q2M", "R3N"]; let i = 0;
  relay = new DoctorRelay({ repo, doctors, outbox, audit, clock, config, lock: noLock, generateCode: () => seq[i++ % seq.length] });
  engine = new Engine({ repo, outbox, audit, llm, clock, config, relay });
});

describe("Engine — patient messages", () => {
  it("creates a conversation with a normalised phone and answers an FAQ verbatim", async () => {
    llm.intents.set("what are your hours", "faq"); llm.faqs.set("what are your hours", "hours");
    await engine.handlePatientMessage(msg("what are your hours"));
    const conv = await repo.getByPhone("+6591234567");
    expect(conv?.mode).toBe("bot");
    expect(outbox.texts("+6591234567")).toEqual([expect.stringContaining("9am to 9pm")]);
    expect(audit.types()).toContain("faq_answered");
  });

  it("sends the menu when no FAQ matches", async () => {
    llm.intents.set("hmm", "faq");
    await engine.handlePatientMessage(msg("hmm"));
    expect(outbox.texts()[0]).toContain("Urgent Care At Home");
  });

  it("treats an urgent keyword as urgent without calling the LLM, alerts doctors, goes human", async () => {
    await engine.handlePatientMessage(msg("my father has chest pain"));
    expect(outbox.texts("+6591234567")[0]).toContain("995");
    const alerts = outbox.templates(DOCTOR);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ template: "doctor_alert", params: [expect.stringContaining("chest pain")] });
    expect((await repo.getByPhone("+6591234567"))?.mode).toBe("human");
    expect(audit.types()).toContain("urgent");
  });

  it("sanitises whitespace in the doctor alert template parameter", async () => {
    await engine.handlePatientMessage(msg("my father has\nchest pain\n\nplease come"));
    const alerts = outbox.templates(DOCTOR);
    expect(alerts).toHaveLength(1);
    const param = (alerts[0] as any).params[0] as string;
    expect(param).not.toMatch(/\n/);
    expect(param).toContain("chest pain");
  });

  it("caps the alert parameter at 300 characters counted by code point, never splitting an emoji", async () => {
    await engine.handlePatientMessage(msg("chest pain " + "😷".repeat(400)));
    const param = (outbox.templates(DOCTOR)[0] as any).params[0] as string;
    expect(Array.from(param)).toHaveLength(300);
    expect(param).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(param.startsWith("URGENT P7K · +6591234567 · chest pain 😷")).toBe(true);
  });

  it("hands off a booking request in phase 1 with the booking text", async () => {
    llm.intents.set("need a doctor to come tonight", "book_visit");
    await engine.handlePatientMessage(msg("need a doctor to come tonight"));
    expect(outbox.texts("+6591234567")).toEqual([expect.stringContaining("arrange the visit")]);
    expect(outbox.templates(DOCTOR)).toHaveLength(1);
    expect(audit.types()).toContain("handoff");
  });

  it("hands off on the second 'other' in a row", async () => {
    await engine.handlePatientMessage(msg("asdf"));
    expect(outbox.templates(DOCTOR)).toHaveLength(0);
    await engine.handlePatientMessage(msg("qwer"));
    expect(outbox.templates(DOCTOR)).toHaveLength(1);
    expect(outbox.texts("+6591234567").at(-1)).toContain("on-duty doctor");
  });

  it("stays silent in human mode and resumes after the idle window", async () => {
    llm.intents.set("hello", "talk_to_human");
    await engine.handlePatientMessage(msg("hello"));
    const before = outbox.items.length;
    await engine.handlePatientMessage(msg("anyone there"));
    expect(outbox.items.length).toBe(before);
    expect(audit.types()).toContain("held_pending_doctor");
    clock.advanceHours(13);
    llm.intents.set("hi again", "faq"); llm.faqs.set("hi again", "fees");
    await engine.handlePatientMessage(msg("hi again"));
    expect(outbox.texts("+6591234567").at(-1)).toContain("$180");
  });

  it("falls back to 'other' when the LLM throws", async () => {
    llm.failNext = true;
    await engine.handlePatientMessage(msg("hello"));
    expect(audit.types()).toContain("llm_error");
    expect(outbox.texts()[0]).toContain("Urgent Care At Home");
  });

  it("passes prior history to the LLM without the new message", async () => {
    const seen: string[][] = [];
    llm.classifyIntent = async ({ history, message }) => { seen.push(history.map(h => h.text)); return { intent: message === "second" ? "faq" : "other", confidence: 1 }; };
    await engine.handlePatientMessage(msg("first"));
    await engine.handlePatientMessage(msg("second"));
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["first", expect.stringContaining("Urgent Care At Home")]);
  });

  it("dedupes nothing itself but records every inbound message", async () => {
    await engine.handlePatientMessage(msg("one", "id1"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    expect((await repo.recentMessages(conv.id, 10)).map(m => m.direction)).toEqual(["in", "out"]);
  });
});

describe("Engine — doctor echoes", () => {
  it("switches to human when a doctor replies from the app, and back on #bot", async () => {
    await engine.handlePatientMessage(msg("asdf"));
    await engine.handleDoctorEcho({ externalId: "e1", to: PATIENT, text: "Hi, Dr A here", at: clock.now() });
    expect((await repo.getByPhone("+6591234567"))?.mode).toBe("human");
    expect(audit.types()).toContain("doctor_took_over");
    await engine.handleDoctorEcho({ externalId: "e2", to: PATIENT, text: " #BOT ", at: clock.now() });
    expect((await repo.getByPhone("+6591234567"))?.mode).toBe("bot");
  });
  it("ignores echoes for unknown conversations", async () => {
    await engine.handleDoctorEcho({ externalId: "e3", to: "6500000000", text: "x", at: clock.now() });
    expect(audit.events).toHaveLength(0);
  });
});

describe("Engine — relay integration", () => {
  it("opens a hand-off with a code and alerts every on-duty doctor with a single-line summary", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    expect(conv).toMatchObject({ mode: "human", code: "P7K", claimedBy: null, realertCount: 0 });
    expect(conv.handoffAt).toEqual(clock.now());
    for (const to of [DOCTOR, DOCTOR_B]) {
      expect(outbox.templates(to)).toEqual([expect.objectContaining({ template: "doctor_alert", params: ["P7K · +6591234567 · please call me"] })]);
    }
    expect(audit.types()).toEqual(expect.arrayContaining(["handoff_opened", "handoff"]));
  });

  it("prefixes URGENT on the alert for urgent messages and keeps the code across hand-offs", async () => {
    await engine.handlePatientMessage(msg("chest pain"));
    expect(outbox.templates(DOCTOR)[0]).toMatchObject({ params: ["URGENT P7K · +6591234567 · chest pain"] });
    const conv = (await repo.getByPhone("+6591234567"))!;
    clock.advanceHours(13);                         // idle → bot again
    llm.intents.set("hello again", "talk_to_human");
    await engine.handlePatientMessage(msg("hello again"));
    expect((await repo.getByPhone("+6591234567"))!.code).toBe(conv.code);
    expect(outbox.templates(DOCTOR)).toHaveLength(2);
  });

  it("holds patient messages while pending and forwards them once claimed", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    await engine.handlePatientMessage(msg("still waiting"));
    expect(audit.types()).toContain("held_pending_doctor");
    expect(outbox.texts(DOCTOR)).toEqual([]);
    const conv = (await repo.getByPhone("+6591234567"))!;
    conv.claimedBy = "dr_example_a"; conv.handoffAt = null; await repo.save(conv);
    await engine.handlePatientMessage(msg("are you coming?"));
    expect(outbox.texts(DOCTOR)).toEqual(["P7K: are you coming?"]);
    expect(outbox.items.at(-1)).toMatchObject({ origin: { doctorId: "dr_example_a", bound: "doctor" } });
    expect(audit.types()).toContain("relay_in");
    expect(outbox.texts("+6591234567")).toHaveLength(1);   // only the hand-off text; bot stays silent
  });

  it("on idle expiry releases a claimed conversation, tells the patient, and answers the message", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    conv.claimedBy = "dr_example_a"; conv.handoffAt = null; await repo.save(conv);
    await doctors.setActive("dr_example_a", conv.id);
    clock.advanceHours(13);
    llm.intents.set("what are your fees", "faq"); llm.faqs.set("what are your fees", "fees");
    await engine.handlePatientMessage(msg("what are your fees"));
    const texts = outbox.texts("+6591234567");
    expect(texts.at(-2)).toContain("back with the");
    expect(texts.at(-1)).toContain("$180");
    expect(await repo.getByPhone("+6591234567")).toMatchObject({ mode: "bot", claimedBy: null, handoffAt: null });
    expect(await doctors.getActive("dr_example_a")).toBeNull();
    expect(audit.types()).toContain("human_idle_resumed");
  });

  it("on idle expiry of a pending conversation resumes silently", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    clock.advanceHours(13);
    llm.intents.set("hi", "faq"); llm.faqs.set("hi", "hours");
    await engine.handlePatientMessage(msg("hi"));
    const texts = outbox.texts("+6591234567");
    expect(texts).toHaveLength(2);                    // hand-off text, then the FAQ answer — no "back with" notice
    expect(texts.at(-1)).toContain("9am to 9pm");
  });

  it("an urgent keyword while pending sends the emergency text and URGENT re-alerts every on-duty doctor, even after escalation", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    clock.advanceMinutes(5); await relay.tick();
    clock.advanceMinutes(5); await relay.tick();
    expect((await repo.getByPhone("+6591234567"))!.realertCount).toBe(2);
    const alertsBefore = outbox.templates(DOCTOR).length;
    llm.classifyIntent = async () => { throw new Error("the LLM must not be called in human mode"); };
    await engine.handlePatientMessage(msg("my father is not breathing"));
    expect(outbox.texts("+6591234567").at(-1)).toContain("995");
    for (const to of [DOCTOR, DOCTOR_B]) {
      expect(outbox.templates(to)).toHaveLength(alertsBefore + 1);
      expect(outbox.templates(to).at(-1)).toMatchObject({ template: "doctor_alert", params: ["URGENT P7K · +6591234567 · my father is not breathing"] });
    }
    expect(await repo.getByPhone("+6591234567")).toMatchObject({ mode: "human", claimedBy: null, realertCount: 2, lastPatientAt: clock.now() });
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "urgent", data: { text: "my father is not breathing" } }),
      expect.objectContaining({ type: "handoff_realert", data: { code: "P7K", reason: "urgent" } }),
    ]));
    expect(audit.types()).not.toContain("llm_error");
  });

  it("an urgent keyword while claimed sends the emergency text and forwards to the holder marked URGENT", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    await repo.save({ ...conv, claimedBy: "dr_example_a", handoffAt: null });
    await engine.handlePatientMessage(msg("chest pain"));
    expect(outbox.texts("+6591234567").at(-1)).toContain("995");
    expect(outbox.texts(DOCTOR)).toEqual(["URGENT P7K: chest pain"]);
    expect(outbox.items.filter(i => i.to === DOCTOR).at(-1)).toMatchObject({ origin: { doctorId: "dr_example_a", bound: "doctor" } });
    expect(outbox.texts(DOCTOR_B)).toEqual([]);
    expect(outbox.templates(DOCTOR)).toHaveLength(1);        // the original alert only
    expect(audit.types()).toEqual(expect.arrayContaining(["relay_in", "urgent"]));
  });

  it("an urgent keyword while held by a doctor who left the roster re-opens the hand-off as URGENT", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    await repo.save({ ...conv, claimedBy: "dr_gone", handoffAt: null });
    await engine.handlePatientMessage(msg("he is unconscious"));
    expect(outbox.texts("+6591234567").at(-1)).toContain("995");
    for (const to of [DOCTOR, DOCTOR_B]) {
      expect(outbox.templates(to).at(-1)).toMatchObject({ params: ["URGENT P7K · +6591234567 · he is unconscious"] });
    }
    expect(await repo.getByPhone("+6591234567")).toMatchObject({ mode: "human", claimedBy: null, handoffAt: clock.now() });
    expect(audit.types()).toEqual(expect.arrayContaining(["doctor_released", "handoff_opened", "urgent"]));
  });

  it("a non-urgent message while claimed is forwarded without the URGENT marker or an emergency text", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    await repo.save({ ...conv, claimedBy: "dr_example_a", handoffAt: null });
    await engine.handlePatientMessage(msg("ok thanks"));
    expect(outbox.texts(DOCTOR)).toEqual(["P7K: ok thanks"]);
    expect(outbox.texts("+6591234567")).toHaveLength(1);
    expect(audit.types()).not.toContain("urgent");
  });

  it("re-opens the hand-off when the holding doctor has left the roster", async () => {
    llm.intents.set("please call me", "talk_to_human");
    await engine.handlePatientMessage(msg("please call me"));
    const conv = (await repo.getByPhone("+6591234567"))!;
    conv.claimedBy = "dr_gone"; conv.handoffAt = null; await repo.save(conv);
    await engine.handlePatientMessage(msg("hello?"));
    expect(audit.types().slice(-2)).toEqual(["doctor_released", "handoff_opened"]);
    expect(outbox.templates(DOCTOR)).toHaveLength(2);
    expect(await repo.getByPhone("+6591234567")).toMatchObject({ mode: "human", claimedBy: null });
  });
});
