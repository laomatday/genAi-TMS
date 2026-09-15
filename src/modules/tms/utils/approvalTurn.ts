interface AssignableRequest {
  assigned_to?: string | null;
}

/**
 * Says whether a reviewer may decide a request right now.
 *
 * The approval queue is scoped on the server by approval role, not by workflow
 * step, so a multi-step request stays visible to everyone whose role can review
 * it — including the manager who already approved step 1 while HR holds step 2.
 * `attendance_requests.assigned_to` is rewritten each time the workflow advances,
 * which makes it the authoritative answer to "whose turn is it".
 *
 * A request with no assignee has no workflow instance driving it, so any
 * eligible reviewer in the queue may act; the database still has the final say.
 */
export function isReviewerTurn(item: AssignableRequest, viewerId: string): boolean {
  const assignee = item.assigned_to?.trim();
  if (!assignee) return true;
  return assignee === viewerId.trim();
}
