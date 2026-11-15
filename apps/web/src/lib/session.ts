import type { Principal, Role } from "@incident/contracts"
import { createContext, useContext } from "react"

/**
 * Who is signed in, as reported by `GET /session`. `undefined` while it is unknown (loading or failed); the
 * UI then hides nothing, and the api still refuses what the user's roles do not allow.
 */
export const SessionContext = createContext<Principal | undefined>(undefined)

export const useSession = (): Principal | undefined => useContext(SessionContext)

/**
 * Whether to offer an action. This only decides what the console shows: the api enforces the role on every
 * request, so a hidden button is a convenience, not the control.
 */
export const can = (principal: Principal | undefined, role: Role): boolean =>
  principal === undefined || principal.roles.includes(role)

export const roleLabel: Record<Role, string> = { viewer: "只读", responder: "响应", approver: "审批" }

/** Where the browser goes to sign in, returning to the current page afterwards. */
export const loginUrl = (returnTo: string): string => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
