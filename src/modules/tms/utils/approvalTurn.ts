interface AssignableRequest {
  assigned_to?: string | null;
}

/** Minimum length the database demands of a reason before it will record a
 *  decision taken on somebody else's behalf. */
export const OVERRIDE_REASON_MIN_LENGTH = 5;

/**
 * Says whether a request is the viewer's own step to decide.
 *
 * The approval queue is scoped on the server by approval role, not by workflow
 * step, so a request stays visible to every reviewer whose role could handle it.
 * `attendance_requests.assigned_to` is rewritten each time the workflow advances,
 * which makes it the authoritative answer to "whose turn is it".
 *
 * A request with no assignee has no workflow instance driving it, so any
 * eligible reviewer may act; the database still has the final say.
 */
export function isReviewerTurn(item: AssignableRequest, viewerId: string): boolean {
  const assignee = item.assigned_to?.trim();
  if (!assignee) return true;
  return assignee === viewerId.trim();
}

/**
 * Says whether the viewer may decide a step that belongs to someone else.
 *
 * HR and Admin carry `attendance.review.override` so cover is possible when the
 * assigned reviewer is away. The database records every such decision as
 * WORKFLOW_REVIEW_OVERRIDE and refuses one without a reason, so the screen must
 * collect that reason rather than letting the reviewer discover the rule from a
 * rejected request.
 */
export function canOverrideReview(capabilities: readonly string[]): boolean {
  return capabilities.includes('attendance.review.override');
}

export function isOverrideReasonValid(reason: string): boolean {
  return reason.trim().length >= OVERRIDE_REASON_MIN_LENGTH;
}
