export interface PosterConfig {
  profileDir: string;
  /** Human-readable user identifier (e.g. "greg") — used in heartbeat agent_name and logs. */
  userId: string;
  /**
   * Supabase auth UUID for this sender (LI_SENDER_UUID env var).
   * Used for sender_id / requested_by filters in linkedin_engagement_queue and
   * linkedin_poster_jobs — both are UUID columns in Postgres and reject short
   * string handles. Must match the UUID in auth.users / team_members for the
   * account running this poster instance.
   */
  senderUuid: string;
  senderName: string;
  senderLinkedInId: string;
  supabaseUrl: string;
  supabaseKey: string;
  port: number;
}

export interface ActionResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
}

export interface PostCommentRequest {
  postUrl: string;
  commentText: string;
}

export interface SendConnectionRequest {
  profileUrl: string;
  noteText?: string;
}

export interface SendDmRequest {
  profileUrl: string;
  messageText: string;
}

export interface PublishPostRequest {
  postText: string;
  imagePaths?: string[];
}
