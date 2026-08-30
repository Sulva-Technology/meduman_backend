import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Mime types we allow as evidence uploads. */
export const ALLOWED_EVIDENCE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

/** 10 MB per file. */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export class CreateEvidenceDto {
  @IsString()
  @MaxLength(200)
  filename!: string;

  @IsIn(ALLOWED_EVIDENCE_MIME)
  mimeType!: (typeof ALLOWED_EVIDENCE_MIME)[number];

  @IsInt()
  @Min(1)
  @Max(MAX_EVIDENCE_BYTES)
  sizeBytes!: number;

  /** Optionally bind the evidence to a specific dispute on the transaction. */
  @IsOptional()
  @IsUUID()
  disputeId?: string;
}
