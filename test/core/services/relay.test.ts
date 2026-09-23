import { describe, it, expect, beforeEach } from "vitest";
import { DoctorRelay, parseDoctorCommand } from "../../../src/core/services/relay/index.js";
import { Engine } from "../../../src/core/services/engine.js";
import { loadConfig } from "../../../src/config/load.js";
import { FakeLlm, FixedClock, InMemoryAudit, InMemoryConversationRepo, InMemoryDoctorState, InMemoryOutbox, noLock } from "../../support/fakes.js";

const PATIENT = "+6591234567", PATIENT2 = "+6591234568";
const DR_A = "+6590000001", DR_B = "+6590000002";
let repo: InMemoryConversationRepo, outbox: InMemoryOutbox, audit: InMemoryAudit, doctors: InMemoryDoctorState, clock: FixedClock, llm: FakeLlm, relay: DoctorRelay, engine: Engine;

beforeEach(() => {
  repo = new InMemoryConversationRepo(); outbox = new InMemoryOutbox(); audit = new InMemoryAudit(); doctors = new InMemoryDoctorState();
  clock = new FixedClock(new Date("2026-09-15T04:00:00Z")); llm = new FakeLlm();
  const config = loadConfig("test/fixtures/config");
  const seq = ["P7K", "Q2M", "R3N"]; let i = 0;
  relay = new DoctorRelay({ repo, doctors, outbox, audit, clock, config, lock: noLock, generateCode: () => seq[i++ % seq.length] });
  engine = new Engine({ repo, outbox, audit, llm, clock, config, relay });
});

async function patientSays(phone: string, text: string) {
  await engine.handlePatientMessage({ externalId: `in-${Math.random()}`, from: phone, text, at: clock.now() });
}
/** Hands the patient off via talk_to_human and returns the conversation. */
async function handedOff(phone = PATIENT, text = "please call me") {
  llm.intents.set(text, "talk_to_human");
  await patientSays(phone, text);
  return (await repo.getByPhone(phone))!;
}
function doctorSays(from: string, text: string) {
  return relay.handleDoctorMessage({ externalId: `d-${Math.random()}`, from, text, at: clock.now() });
}
const lastText = (to: string) => outbox.texts(to).at(-1);

describe("parseDoctorCommand", () => {
  it("parses commands case-insensitively with the code upper-cased", () => {
    expect(parseDoctorCommand(" #TAKE p7k ")).toEqual({ kind: "take", code: "P7K" });
    expect(parseDoctorCommand("#bot P7K")).toEqual({ kind: "release", code: "P7K" });
    expect(parseDoctorCommand("#bot")).toEqual({ kind: "release", code: null });
    expect(parseDoctorCommand("#list")).toEqual({ kind: "list" });
    expect(parseDoctorCommand("#help")).toEqual({ kind: "help" });
    expect(parseDoctorCommand("#call P7K")).toEqual({ kind: "call" });
    expect(parseDoctorCommand("#take")).toEqual({ kind: "unknown" });
    expect(parseDoctorCommand("#whatever")).toEqual({ kind: "unknown" });
  });
  it("treats a leading code-shaped token as a target and keeps the rest verbatim", () => {
    expect(parseDoctorCommand("p7k I'm on my way\nETA 20 min")).toEqual({ kind: "text", code: "P7K", text: "I'm on my way\nETA 20 min" });
  });
  it("relays plain text, including text that starts with a word that is not a code", () => {
    expect(parseDoctorCommand("take two paracetamol")).toEqual({ kind: "text", code: null, text: "take two paracetamol" });
    expect(parseDoctorCommand("yes I will come")).toEqual({ kind: "text", code: null, text: "yes I will come" });
    expect(parseDoctorCommand("P7K")).toEqual({ kind: "text", code: null, text: "P7K" });
  });
});

describe("DoctorRelay — take and release", () => {
  it("#take claims a pending patient, replays held messages, notifies the patient, sets the doctor's active patient", async () => {
    await handedOff();
    clock.advanceMinutes(1);
    await patientSays(PATIENT, "still here");
    clock.advanceMinutes(1);
    await doctorSays(DR_A, "#take p7k");
    const conv = (await repo.getByPhone(PATIENT))!;
    expect(conv).toMatchObject({ mode: "human", claimedBy: "dr_example_a", handoffAt: null });
    expect(conv.lastHumanAt).toEqual(clock.now());
    expect(outbox.texts(DR_A)).toEqual([expect.stringContaining("You have P7K (+6591234567)"), "P7K: please call me", "P7K: still here"]);
    expect(lastText(PATIENT)).toBe("Dr Example A is with you now and will reply here.");
    expect(await doctors.getActive("dr_example_a")).toBe(conv.id);
    expect(audit.types()).toContain("doctor_claimed");
  });

  it("second doctor is told who has the patient; the first keeps it", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_B, "#take P7K");
    expect(lastText(DR_B)).toBe("P7K is already with Dr Example A.");
    expect((await repo.getByPhone(PATIENT))!.claimedBy).toBe("dr_example_a");
    expect(audit.events.filter(e => e.type === "doctor_command_rejected")).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: "taken_by_other" }) })]);
  });

  it("rejects unknown codes and conversations not in human mode", async () => {
    await doctorSays(DR_A, "#take ZZZ");
    expect(lastText(DR_A)).toContain("No patient with code ZZZ");
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_A, "#bot P7K");
    await doctorSays(DR_B, "#take P7K");
    expect(lastText(DR_B)).toBe("P7K is not waiting for a doctor right now.");
  });

  it("a holder who left the roster does not lock the patient out: #take claims it normally", async () => {
    const conv = await handedOff();
    await repo.save({ ...conv, claimedBy: "dr_gone" });   // handoffAt kept: replay from the hand-off message
    await doctorSays(DR_A, "#take P7K");
    expect(await repo.getByPhone(PATIENT)).toMatchObject({ mode: "human", claimedBy: "dr_example_a", handoffAt: null });
    expect(outbox.texts(DR_A)).toEqual([expect.stringContaining("You have P7K"), "P7K: please call me"]);
    expect(lastText(PATIENT)).toBe("Dr Example A is with you now and will reply here.");
    expect(audit.types()).toContain("doctor_claimed");
    expect(audit.types()).not.toContain("doctor_command_rejected");
  });

  it("#bot on a code held by a doctor who left the roster says it must be taken first", async () => {
    const conv = await handedOff();
    await repo.save({ ...conv, claimedBy: "dr_gone", handoffAt: null });
    await doctorSays(DR_A, "#bot P7K");
    expect(lastText(DR_A)).toBe("You have not taken P7K yet. Send #take P7K first.");
    expect((await repo.getByPhone(PATIENT))!.claimedBy).toBe("dr_gone");
  });

  it("taking a patient you already hold just repeats the confirmation, without replaying messages", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    const before = outbox.items.length;
    await doctorSays(DR_A, "#take P7K");
    expect(outbox.items.length).toBe(before + 1);
    expect(lastText(DR_A)).toContain("You have P7K");
  });

  it("#bot CODE releases: bot mode, patient notified, active cleared; only the holder may release", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_B, "#bot P7K");
    expect(lastText(DR_B)).toBe("P7K is already with Dr Example A.");
    await doctorSays(DR_A, "#bot P7K");
    expect(await repo.getByPhone(PATIENT)).toMatchObject({ mode: "bot", claimedBy: null, handoffAt: null, otherCount: 0 });
    expect(lastText(DR_A)).toBe("P7K is back with the assistant.");
    expect(lastText(PATIENT)).toContain("back with the Urgent Care At Home assistant");
    expect(await doctors.getActive("dr_example_a")).toBeNull();
    expect(audit.types()).toContain("doctor_released");
  });

  it("#bot alone releases the active patient; with nothing active it says so", async () => {
    await doctorSays(DR_A, "#bot");
    expect(lastText(DR_A)).toContain("No active patient");
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_A, "#bot");
    expect((await repo.getByPhone(PATIENT))!.mode).toBe("bot");
  });

  it("#bot on a pending code nobody holds explains that it must be taken first", async () => {
    await handedOff();
    await doctorSays(DR_A, "#bot P7K");
    expect(lastText(DR_A)).toBe("You have not taken P7K yet. Send #take P7K first.");
  });

  it("#help, #call and unknown commands reply with fixed texts; non-roster senders are ignored", async () => {
    await doctorSays(DR_A, "#help");
    expect(lastText(DR_A)).toContain("#take CODE");
    await doctorSays(DR_A, "#call P7K");
    expect(lastText(DR_A)).toBe("Calls are not available yet.");
    await doctorSays(DR_A, "#nonsense");
    expect(lastText(DR_A)).toContain("#take CODE");
    const n = outbox.items.length;
    await doctorSays("+6599999999", "#take P7K");
    expect(outbox.items.length).toBe(n);
  });
});

describe("DoctorRelay — replies and #list", () => {
  it("a plain reply goes to the doctor's active patient, stored as a doctor message, with origin for failure handling", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    clock.advanceMinutes(2);
    await doctorSays(DR_A, "On my way, 20 minutes");
    expect(lastText(PATIENT)).toBe("On my way, 20 minutes");
    expect(outbox.items.at(-1)).toMatchObject({ to: PATIENT, origin: { doctorId: "dr_example_a", bound: "patient" } });
    const conv = (await repo.getByPhone(PATIENT))!;
    expect((await repo.recentMessages(conv.id, 1))[0]).toMatchObject({ direction: "doctor", text: "On my way, 20 minutes" });
    expect(conv.lastHumanAt).toEqual(clock.now());
    expect(audit.types()).toContain("relay_out");
    expect(outbox.texts(DR_A).at(-1)).not.toBe("→ P7K");   // one patient: no confirmation
  });

  it("with two patients a coded reply targets that patient and becomes active; an uncoded one goes to the active patient with a confirmation", async () => {
    await handedOff(PATIENT, "please call me");
    await handedOff(PATIENT2, "need help");
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_A, "#take Q2M");         // Q2M is now active
    await doctorSays(DR_A, "P7K I will call you first");
    expect(lastText(PATIENT)).toBe("I will call you first");
    expect(await doctors.getActive("dr_example_a")).toBe((await repo.getByPhone(PATIENT))!.id);
    await doctorSays(DR_A, "be there at 6");
    expect(lastText(PATIENT)).toBe("be there at 6");
    expect(lastText(DR_A)).toBe("→ P7K");
    expect(outbox.texts(PATIENT2)).toEqual([expect.stringContaining("on-duty doctor"), expect.stringContaining("Dr Example A is with you")]);
  });

  it("a leading code the doctor does not hold is relayed as ordinary text", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_A, "Q2M is my room number");
    expect(lastText(PATIENT)).toBe("Q2M is my room number");
  });

  it("a leading code that is pending (not taken by the doctor) is rejected and nothing is relayed", async () => {
    await handedOff(PATIENT, "please call me");
    await handedOff(PATIENT2, "need help");       // Q2M, pending
    await doctorSays(DR_A, "#take P7K");
    const toPatient = outbox.texts(PATIENT).length, toPatient2 = outbox.texts(PATIENT2).length;
    await doctorSays(DR_A, "Q2M hi");
    expect(lastText(DR_A)).toBe("You have not taken Q2M yet. Send #take Q2M first.");
    expect(outbox.texts(PATIENT)).toHaveLength(toPatient);
    expect(outbox.texts(PATIENT2)).toHaveLength(toPatient2);
    expect(audit.events.filter(e => e.type === "doctor_command_rejected").at(-1)).toMatchObject({ data: { doctorId: "dr_example_a", reason: "not_taken" } });
    expect(audit.types()).not.toContain("relay_out");
  });

  it("a leading code held by another doctor is rejected with the holder's name and nothing is relayed", async () => {
    await handedOff(PATIENT, "please call me");
    await handedOff(PATIENT2, "need help");
    await doctorSays(DR_A, "#take P7K");
    await doctorSays(DR_B, "#take Q2M");
    const before = outbox.texts(PATIENT).length + outbox.texts(PATIENT2).length;
    await doctorSays(DR_A, "Q2M hi");
    expect(lastText(DR_A)).toBe("Q2M is already with Dr Example B.");
    expect(outbox.texts(PATIENT).length + outbox.texts(PATIENT2).length).toBe(before);
    expect(audit.events.filter(e => e.type === "doctor_command_rejected").at(-1)).toMatchObject({ data: { reason: "taken_by_other" } });
  });

  it("a leading code held by a doctor who left the roster is treated as not taken", async () => {
    await handedOff(PATIENT, "please call me");
    const gone = await handedOff(PATIENT2, "need help");
    await repo.save({ ...gone, claimedBy: "dr_gone", handoffAt: null });
    await doctorSays(DR_A, "#take P7K");
    const before = outbox.texts(PATIENT).length + outbox.texts(PATIENT2).length;
    await doctorSays(DR_A, "Q2M hi");
    expect(lastText(DR_A)).toBe("You have not taken Q2M yet. Send #take Q2M first.");
    expect(outbox.texts(PATIENT).length + outbox.texts(PATIENT2).length).toBe(before);
  });

  it("with no active patient the reply is refused and nothing reaches a patient", async () => {
    await handedOff();
    await doctorSays(DR_A, "hello?");
    expect(lastText(DR_A)).toContain("No active patient");
    expect(outbox.texts(PATIENT)).toHaveLength(1);
  });

  it("#list shows the doctor's patients with the last patient line and minutes since", async () => {
    await doctorSays(DR_A, "#list");
    expect(lastText(DR_A)).toBe("You have no patients right now.");
    await handedOff(PATIENT, "please call me");
    await doctorSays(DR_A, "#take P7K");
    clock.advanceMinutes(7);
    await doctorSays(DR_A, "#list");
    expect(lastText(DR_A)).toBe("Your patients:\nP7K · +6591234567 · please call me · 7m ago");
  });
});

describe("DoctorRelay — re-alert tick", () => {
  it("re-alerts as URGENT after handoff_realert_minutes, tells the patient after double, then stays pending", async () => {
    await handedOff();
    clock.advanceMinutes(4); await relay.tick();
    expect(outbox.templates(DR_A)).toHaveLength(1);
    clock.advanceMinutes(1); await relay.tick();
    expect(outbox.templates(DR_A)).toHaveLength(2);
    expect(outbox.templates(DR_A)[1]).toMatchObject({ params: ["URGENT P7K · +6591234567 · please call me"] });
    expect((await repo.getByPhone(PATIENT))!.realertCount).toBe(1);
    await relay.tick();                                     // same minute: nothing more
    expect(outbox.templates(DR_A)).toHaveLength(2);
    clock.advanceMinutes(5); await relay.tick();
    expect(lastText(PATIENT)).toContain("A doctor will contact you");
    expect((await repo.getByPhone(PATIENT))).toMatchObject({ mode: "human", claimedBy: null, realertCount: 2 });
    expect(audit.types()).toEqual(expect.arrayContaining(["handoff_realert", "handoff_unclaimed"]));
    clock.advanceMinutes(30); await relay.tick();
    expect(outbox.templates(DR_A)).toHaveLength(2);         // no further alerts
    await doctorSays(DR_A, "#take P7K");                    // still claimable
    expect((await repo.getByPhone(PATIENT))!.claimedBy).toBe("dr_example_a");
  });

  it("does nothing for claimed conversations", async () => {
    await handedOff();
    await doctorSays(DR_A, "#take P7K");
    clock.advanceMinutes(30); await relay.tick();
    expect(outbox.templates(DR_A)).toHaveLength(1);
  });

  it("isolates a failing conversation so later pending conversations still get processed", async () => {
    await handedOff(PATIENT, "please call me");
    await handedOff(PATIENT2, "need help");
    const realEnqueue = outbox.enqueue.bind(outbox);
    outbox.enqueue = async (item) => {
      if (item.kind === "template" && (item.params ?? []).some(p => p.includes("P7K"))) throw new Error("boom");
      return realEnqueue(item);
    };
    clock.advanceMinutes(5); await relay.tick();
    expect(outbox.templates(DR_A)).toEqual(expect.arrayContaining([expect.objectContaining({ params: ["URGENT Q2M · +6591234568 · need help"] })]));
    expect(audit.types()).toContain("relay_tick_error");
  });
});

describe("DoctorRelay — code allocation", () => {
  function relayWithCodes(codes: string[]) {
    let i = 0;
    const config = loadConfig("test/fixtures/config");
    relay = new DoctorRelay({ repo, doctors, outbox, audit, clock, config, lock: noLock, generateCode: () => codes[i++] });
    engine = new Engine({ repo, outbox, audit, llm, clock, config, relay });
  }

  it("draws again when the generated code is already in use", async () => {
    relayWithCodes(["P7K", "P7K", "Q2M"]);
    await handedOff(PATIENT, "please call me");
    await handedOff(PATIENT2, "need help");
    expect((await repo.getByPhone(PATIENT))!.code).toBe("P7K");
    expect(await repo.getByPhone(PATIENT2)).toMatchObject({ code: "Q2M", mode: "human", claimedBy: null });
    expect(outbox.templates(DR_A).at(-1)).toMatchObject({ params: ["Q2M · +6591234568 · need help"] });
  });

  it("retries with a fresh code when a concurrent hand-off saved the same code first", async () => {
    relayWithCodes(["Q2M", "R3N"]);
    const rival = await repo.create(PATIENT2);
    await repo.save({ ...rival, mode: "human", code: "Q2M", handoffAt: clock.now() });
    // The rival's save lands between our availability check and our save: the check sees Q2M as free once.
    const realGetByCode = repo.getByCode.bind(repo);
    let raced = false;
    repo.getByCode = async (code) => (code === "Q2M" && !raced ? ((raced = true), null) : realGetByCode(code));
    await handedOff(PATIENT, "please call me");
    expect(raced).toBe(true);
    expect(await repo.getByPhone(PATIENT)).toMatchObject({ code: "R3N", mode: "human", claimedBy: null });
    expect((await repo.getByPhone(PATIENT2))!.code).toBe("Q2M");
    expect(outbox.templates(DR_A)).toEqual([expect.objectContaining({ params: ["R3N · +6591234567 · please call me"] })]);
    expect(audit.events.find(e => e.type === "handoff_opened")).toMatchObject({ data: { code: "R3N" } });
  });
});

describe("DoctorRelay — delivery failures", () => {
  it("a failed relay to the patient tells the doctor the window is closed", async () => {
    const conv = await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await relay.handleRelayFailure({ doctorId: "dr_example_a", bound: "patient" }, conv.id);
    expect(lastText(DR_A)).toContain("Could not deliver your reply to P7K");
    expect(audit.types()).toContain("relay_window_closed");
  });
  it("a failed relay to the doctor re-sends the alert template to that doctor", async () => {
    const conv = await handedOff();
    await doctorSays(DR_A, "#take P7K");
    await relay.handleRelayFailure({ doctorId: "dr_example_a", bound: "doctor" }, conv.id);
    expect(outbox.templates(DR_A)).toHaveLength(2);
    expect(outbox.templates(DR_A)[1]).toMatchObject({ params: ["P7K · +6591234567 · please call me"] });
  });
  it("audits a failure even when the doctor has left the roster, without sending anything", async () => {
    const conv = await handedOff();
    await doctorSays(DR_A, "#take P7K");
    const before = outbox.items.length;
    await relay.handleRelayFailure({ doctorId: "dr_gone", bound: "patient" }, conv.id);
    expect(outbox.items.length).toBe(before);
    expect(audit.types()).toContain("relay_window_closed");
  });
});

describe("InMemoryConversationRepo behaves like Postgres", () => {
  it("returns copies, so a change without save is not persisted", async () => {
    const created = await repo.create(PATIENT);
    created.mode = "human";
    for (const got of [await repo.getByPhone(PATIENT), await repo.getById(created.id)]) {
      expect(got!.mode).toBe("bot");
      got!.claimedBy = "dr_example_a"; got!.code = "P7K";
    }
    expect(await repo.getByPhone(PATIENT)).toMatchObject({ claimedBy: null, code: null });
    const saved = { ...created, mode: "human" as const, code: "P7K", claimedBy: "dr_example_a", handoffAt: null };
    await repo.save(saved);
    (await repo.getByCode("P7K"))!.mode = "bot";
    (await repo.listClaimedBy("dr_example_a"))[0].mode = "bot";
    expect((await repo.getByPhone(PATIENT))!.mode).toBe("human");
  });
  it("returns listPending results as copies", async () => {
    const c = await repo.create(PATIENT);
    await repo.save({ ...c, mode: "human", code: "P7K", handoffAt: clock.now() });
    (await repo.listPending())[0].mode = "bot";
    expect((await repo.getByPhone(PATIENT))!.mode).toBe("human");
  });
  it("orders listClaimedBy by lastPatientAt desc, nulls last", async () => {
    const t = (m: number) => new Date(clock.now().getTime() + m * 60_000);
    const rows: Array<[string, string, Date | null]> = [["+6591000001", "B22", t(1)], ["+6591000002", "C33", null], ["+6591000003", "D44", t(5)]];
    for (const [phone, code, at] of rows) {
      const c = await repo.create(phone);
      await repo.save({ ...c, mode: "human", code, claimedBy: "dr_example_a", lastPatientAt: at });
    }
    expect((await repo.listClaimedBy("dr_example_a")).map(c => c.code)).toEqual(["D44", "B22", "C33"]);
  });
});
