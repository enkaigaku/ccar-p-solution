import { Schema } from "effect"
import { InvestigationId, InvestigationUsage } from "./Investigation.ts"

export const PostmortemId = Schema.String.pipe(Schema.brand("PostmortemId"))
export type PostmortemId = typeof PostmortemId.Type

/**
 * - `draft`: written by the model (and possibly edited by a person), not in the knowledge base
 * - `published`: a reviewer accepted it and it was ingested into the knowledge base
 * - `rejected`: a reviewer declined it; it never reaches the knowledge base
 */
export const PostmortemStatus = Schema.Literals(["draft", "published", "rejected"])
export type PostmortemStatus = typeof PostmortemStatus.Type

/** The sections a postmortem has. They become the H2 sections the knowledge base chunks by. */
export class PostmortemBody extends Schema.Class<PostmortemBody>("@incident/contracts/PostmortemBody")({
  title: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
  symptoms: Schema.NonEmptyString,
  rootCause: Schema.NonEmptyString,
  mitigation: Schema.NonEmptyString,
}) {}

/**
 * A postmortem of one finished investigation. The model writes the first version; a person may edit it, and
 * only a reviewer's decision moves it into the knowledge base. Model-written text is never ingested unreviewed.
 */
export class PostmortemDraft extends Schema.Class<PostmortemDraft>("@incident/contracts/PostmortemDraft")({
  id: PostmortemId,
  investigationId: InvestigationId,
  status: PostmortemStatus,
  /** The service the incident was about; becomes the document's `service` metadata in the knowledge base. */
  service: Schema.String,
  body: PostmortemBody,
  /** The model that served the generation request, and the prompt version it used. */
  model: Schema.String,
  promptVersion: Schema.String,
  usage: InvestigationUsage,
  /** True once a person changed the model's text. */
  edited: Schema.Boolean,
  /** `Principal.name` of whoever published or rejected it. Absent while it is a draft. */
  reviewedBy: Schema.optionalKey(Schema.String),
  /** Knowledge-base source id and the index version that first contained it. Present once published. */
  sourceId: Schema.optionalKey(Schema.String),
  indexVersion: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
}) {}

export const PostmortemDecision = Schema.Literals(["publish", "reject"])
export type PostmortemDecision = typeof PostmortemDecision.Type
