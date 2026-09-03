import { rosterStore } from "../src/rosterStore";

describe("rosterStore", () => {
  beforeEach(() => {
    rosterStore.assignments = [];
    rosterStore.leave = [];
    rosterStore.lastWarnings = [];
  });

  it("regenerating a year replaces that year's assignments instead of duplicating", () => {
    const first = rosterStore.generateYear(2026);
    const countAfterFirst = rosterStore.listAssignments({}).length;
    expect(countAfterFirst).toBe(first.assignmentsCreated);

    rosterStore.generateYear(2026);
    const countAfterSecond = rosterStore.listAssignments({}).length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("approving leave clears the staff member off shifts in that window", () => {
    rosterStore.generateYear(2026);
    const outlet = rosterStore.listOutlets()[0];
    const someStaff = rosterStore.listStaff(outlet.outletId)[0];
    const request = rosterStore.requestLeave({
      staffId: someStaff.staffId,
      startDate: "2026-03-02",
      endDate: "2026-03-06",
    });

    rosterStore.decideLeave(request.leaveRequestId, "approved");

    const affected = rosterStore
      .listAssignments({ outletId: outlet.outletId })
      .filter((a) => a.date >= "2026-03-02" && a.date <= "2026-03-06");

    for (const a of affected) {
      if (a.staffId === someStaff.staffId) {
        fail(`assignment ${a.assignmentId} still has ${someStaff.staffId} after approved leave`);
      }
    }
  });

  it("rejects swapping shifts of different roles", () => {
    rosterStore.generateYear(2026);
    const all = rosterStore.listAssignments({});
    const a = all.find((x) => x.role === "duty_manager" && x.staffId);
    const b = all.find((x) => x.role === "reception" && x.staffId && x.assignmentId !== a?.assignmentId);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const result = rosterStore.swapAssignments(a!.assignmentId, b!.assignmentId);
    expect(result.ok).toBe(false);
  });

  it("swaps staff between two same-role assignments on different dates", () => {
    rosterStore.generateYear(2026);
    const all = rosterStore.listAssignments({});
    const byStaffDate = new Set(all.filter((x) => x.staffId).map((x) => `${x.staffId}|${x.date}`));

    const coachShifts = all.filter((x) => x.role === "coach" && x.staffId);
    let pair: [(typeof coachShifts)[number], (typeof coachShifts)[number]] | undefined;
    outer: for (const a of coachShifts) {
      for (const b of coachShifts) {
        if (a.staffId === b.staffId || a.date === b.date) continue;
        if (byStaffDate.has(`${b.staffId}|${a.date}`)) continue;
        if (byStaffDate.has(`${a.staffId}|${b.date}`)) continue;
        pair = [a, b];
        break outer;
      }
    }
    expect(pair).toBeDefined();
    const [staffA, staffB] = pair!;

    const originalA = staffA.staffId;
    const originalB = staffB.staffId;

    const result = rosterStore.swapAssignments(staffA.assignmentId, staffB.assignmentId);
    expect(result.ok).toBe(true);
    expect(staffA.staffId).toBe(originalB);
    expect(staffB.staffId).toBe(originalA);
  });
});
