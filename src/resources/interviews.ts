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
}
