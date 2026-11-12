import { Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { IncidentClient } from "./IncidentClient.ts"
import { InvestigationEvents } from "./InvestigationEvents.ts"

export const AppLayer = Layer.mergeAll(IncidentClient.layer, InvestigationEvents.layer).pipe(
  Layer.provide(FetchHttpClient.layer),
)

/** The one bridge between React and Effect in the browser. Built lazily on first use. */
export const runtime = ManagedRuntime.make(AppLayer)
