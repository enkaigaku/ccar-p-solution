import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
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
  return (
    <>
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
      </header>
      <Outlet />
    </>
  )
}
