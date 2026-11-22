import { cleanBody } from "../core.js";
import type { BodyOf, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export type InterviewLink = ResponseOf<"/v1/interview/links", "post">;
export type InterviewLinkBody = BodyOf<"/v1/interview/links", "post">;
export type InterviewResult = ResponseOf<"/v1/interview/sendables/links/{link_id}/result", "get">;
export type SendableInterviewPage = ResponseOf<"/v1/interview/sendables", "get">;
export type SendableInterviewBody = BodyOf<"/v1/interview/sendables", "post">;
export type SendableLink = ResponseOf<"/v1/interview/sendables/{sendable_id}/links", "post">;
export type SendableLinkBody = BodyOf<"/v1/interview/sendables/{sendable_id}/links", "post">;
/** A drafted interview from review flags, with which flag each question asks about. */
export type ReviewInterviewDraft = ResponseOf<"/v1/projects/{project_id}/interviews/from-reviews", "post">;
type ReviewInterviewBody = BodyOf<"/v1/projects/{project_id}/interviews/from-reviews", "post">;

/** Who an interview drafted from review flags is for: a member (`userId`), or a name and/or email. */
export interface ReviewInterviewParticipant {
  /** A member of your organization; their name and email label the link. */
  userId?: string;
  /** The person's name, shown beside the link in Beakr. */
  name?: string;
  /** The person's email, shown beside the link in Beakr. Beakr sends nothing to it. */
  email?: string;
}

/** What `draftFromReviews` asks about, and who for. Every field is optional. */
export interface DraftFromReviewsOptions {
  /** The review flags (proposal ids) to ask about, in order, up to 100. Omitted: every open review flag. */
  proposalIds?: string[];
  /** Ask only about flags of these kinds. Omitted: every kind. Ignored with `proposalIds`. */
  kinds?: NonNullable<ReviewInterviewBody["kinds"]>;
  /** The most flags to ask about, one question each: 1 to 30, default 30. */
  maxQuestions?: number;
  /** Who it is for. Given, the interview also gets that person's link (`link`, `link_url`); nothing is sent. */
  participant?: ReviewInterviewParticipant;
  /** How long the participant's link works, in days: 1 to 90, default 14. */
  linkExpiresInDays?: number;
  /** The interview's title, in place of the drafted one. */
  title?: string;
  /** The interview's goals, in place of the drafted ones. */
  goals?: string;
}

export interface CreateLinkOptions {
  /** What the interview should find out. */
  goal?: string;
  /** Questions to make sure it asks. */
  questions?: InterviewLinkBody["questions"];
  /** Who it is for (`name`, `email`); recorded on the link, nothing is sent. */
  recipient?: InterviewLinkBody["recipient"];
  /** ISO timestamp; the link stops working then. */
  expiresAt?: string;
}

/**
 * Interviews you send: create one and get a link to hand to anyone, read the
 * result when they finish, and send the finished interview into projects'
 * Knowledge. Scopes `interviews:read` / `interviews:write`.
 */
export class Interviews extends Resource {
  /**
   * Create an interview and one link to it in one call. Answers `url` (the
   * link to send; shown once), `link_id`, `sendable_id`, `expires_at` and
   * `result_url`.
   */
  createLink(title: string, options: CreateLinkOptions = {}): Promise<InterviewLink> {
    return this.transport.request({
      method: "POST",
      path: "/v1/interview/links",
      idempotent: true,
      body: cleanBody({
        title,
        goal: options.goal,
        questions: options.questions,
        recipient: options.recipient,
        expires_at: options.expiresAt,
      }) as InterviewLinkBody,
    });
  }

  /** What happened on a link: `status`, the summary and transcript once finished. */
  linkResult(linkId: string): Promise<InterviewResult> {
    return this.transport.request({
      method: "GET",
      path: `/v1/interview/sendables/links/${enc(linkId)}/result`,
    });
  }

  /** Put a finished interview into one or more projects' Knowledge. */
  sendToProjects(linkId: string, projectIds: string[]): Promise<unknown> {
    return this.transport.request({
      method: "POST",
      path: `/v1/interview/sendables/links/${enc(linkId)}/knowledge`,
      idempotent: true,
      body: { project_ids: projectIds },
    });
  }

  /** Stop a link working; its result so far stays readable. */
  revokeLink(linkId: string): Promise<void> {
    return this.transport.request({
      method: "POST",
      path: `/v1/interview/sendables/links/${enc(linkId)}/revoke`,
      responseType: "none",
    });
  }

  /** One page of your sendable interviews, newest first. */
  sendables(query: { cursor?: string; limit?: number } = {}): Promise<SendableInterviewPage> {
    return this.transport.request({ method: "GET", path: "/v1/interview/sendables", query });
  }

  /** Create a sendable interview to make links for (`linkFor`). */
  createSendable(body: SendableInterviewBody): Promise<unknown> {
    return this.transport.request({
      method: "POST",
      path: "/v1/interview/sendables",
      idempotent: true,
      body,
    });
  }

  /** Another link to an existing sendable interview. */
  linkFor(sendableId: string, body: SendableLinkBody = {}): Promise<SendableLink> {
    return this.transport.request({
      method: "POST",
      path: `/v1/interview/sendables/${enc(sendableId)}/links`,
      idempotent: true,
      body,
    });
  }

  /**
   * Turn a project's open review flags into one interview: one plain-language key
   * question per flag. By default every open review flag, newest first, up to
   * `maxQuestions` (30); flags past it come back in `skipped` as
   * `over_question_limit`. `kinds` narrows the kinds and `proposalIds` names the
   * flags. Needs `interviews:write` and `kb:read`.
   *
   * Without `participant` the interview is a draft a person edits (`edit_url`) and
   * sends. With one, it also gets that person's link: `link` (`link_id`, `label`,
   * `expires_at`, `result_url`) and `link_url`, shown once (absent on a replay,
   * `secret_redacted: true`). Beakr sends nothing; you deliver the link. Nothing
   * to ask answers `interview: null` with `empty_reason` and `message`. Each answer
   * comes back on its flag (`interview_answers`) as a suggestion.
   */
  draftFromReviews(projectId: string, options: DraftFromReviewsOptions = {}): Promise<ReviewInterviewDraft> {
    const participant = options.participant
      ? cleanBody({
          user_id: options.participant.userId,
          name: options.participant.name,
          email: options.participant.email,
        })
      : undefined;
    return this.transport.request({
      method: "POST",
      path: `/v1/projects/${enc(projectId)}/interviews/from-reviews`,
      idempotent: true,
      body: cleanBody({
        proposal_ids: options.proposalIds?.length ? options.proposalIds : undefined,
        kinds: options.kinds?.length ? options.kinds : undefined,
        max_questions: options.maxQuestions,
        participant,
        link_expires_in_days: options.linkExpiresInDays,
        title: options.title,
        goals: options.goals,
      }) as ReviewInterviewBody,
    });
  }
}
