export interface PosterConfig {
  profileDir: string;
  userId: string;
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
