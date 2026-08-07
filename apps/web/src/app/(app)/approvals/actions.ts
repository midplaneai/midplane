"use server";

// Approve / deny a held write.
//
// Authorization is checked HERE, not only in the page: the page hides the
// buttons from a member, but a server action is a public endpoint and a hidden
// button is not a permission.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentCustomer } from "@/lib/customer";
import { getActiveRole } from "@/lib/org-auth";
import { isManagerRole } from "@/lib/org-roles";
import { decideApproval } from "@/lib/approval-queue";

export interface DecideState {
  error?: string;
  ok?: boolean;
}

export async function decideAction(
  _prev: DecideState,
  formData: FormData,
): Promise<DecideState> {
  const customer = await currentCustomer();
  if (!customer) return { error: "Not signed in." };

  const role = await getActiveRole();
  if (!isManagerRole(role?.role)) {
    // A member can watch the queue — that is how they learn why their agent
    // stopped — but deciding a production write is a management act.
    return { error: "Only the workspace owner and admins can decide approvals." };
  }

  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "");

  if (!id) return { error: "Missing approval." };
  if (decision !== "approved" && decision !== "denied") {
    return { error: "Unknown decision." };
  }

  const result = await decideApproval({
    region: customer.region,
    customerId: customer.id,
    id,
    decision,
    userId: role!.userId,
    note: note || null,
  });

  if (!result.ok) {
    // These are all races a normal user can lose, so they return state rather
    // than throwing — a Next runtime overlay is the wrong response to "someone
    // else got there first".
    const message =
      result.error === "not_found"
        ? "That request no longer exists."
        : result.error === "expired"
          ? "That request expired before it could be decided. The agent can ask again."
          : "Someone else already decided that request.";
    return { error: message };
  }

  revalidatePath("/approvals");
  revalidatePath(`/approvals/${id}`);

  // Only ever an in-app path we chose ourselves — never a value echoed back
  // from the form beyond this allowlist, so this cannot become an open redirect.
  const target = formData.get("redirectTo");
  if (target === "/approvals") redirect("/approvals");

  return { ok: true };
}
