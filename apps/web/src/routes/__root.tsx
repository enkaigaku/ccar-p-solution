import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { IncidentClient } from "../lib/IncidentClient.ts"
import { run } from "../lib/load.ts"
import { roleLabel, SessionContext } from "../lib/session.ts"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  // Without a session this fails with `Unauthorized`, and `run` sends the browser to the login page.
  loader: () => run(IncidentClient.use((client) => client.session.current())),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Incident Copilot" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: Layout,
  notFoundComponent: () => (
    <main className="page">
      <p className="empty">页面不存在。</p>
    </main>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Layout() {
  const session = Route.useLoaderData()
  const principal = session._tag === "Ok" ? session.value : undefined
  return (
    <SessionContext.Provider value={principal}>
      <header className="topbar">
        <Link to="/" className="brand">
          Incident Copilot
        </Link>
        <nav>
          <Link to="/" activeOptions={{ exact: true }}>
            告警
          </Link>
        </nav>
        <span className="tag tag-ai" title="调查报告由 Claude 生成，结论需人工核对">
          AI 生成内容需人工核对
        </span>
        {principal === undefined ? null : (
          <div className="session">
            <span className="session-user" title={`账号 ${principal.subject}`}>
              {principal.name}
            </span>
            {principal.roles.length === 0 ? (
              <span className="badge">无角色</span>
            ) : (
              principal.roles.map((role) => (
                <span key={role} className="badge" title={role}>
                  {roleLabel[role]}
                </span>
              ))
            )}
            {/* A form POST, not a link: signing out changes state and must not be triggerable by a GET. */}
            <form method="post" action="/auth/logout">
              <button type="submit">退出登录</button>
            </form>
          </div>
        )}
      </header>
      <Outlet />
    </SessionContext.Provider>
  )
}
