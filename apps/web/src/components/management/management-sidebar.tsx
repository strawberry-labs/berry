import * as React from "react";
import { Building2, Menu, ShieldCheck, SquareArrowOutUpRight, X } from "lucide-react";
import type { Organization, OrgPermission } from "@berry/shared";
import { ADMIN_NAV, PERSONAL_NAV, PLATFORM_NAV, type ManagementKind } from "./management-navigation";
import { Button, FormSelect } from "./management-primitives";

export function ManagementSidebar({ kind, tab, organizations, activeOrganizationId, permissions, platformAuthorized, onNavigate, onOrganizationChange, onBack }: {
  kind: ManagementKind; tab: string; organizations: Organization[]; activeOrganizationId: string; permissions: OrgPermission[]; platformAuthorized: boolean;
  onNavigate: (kind: ManagementKind, tab: string) => void; onOrganizationChange: (id: string) => void; onBack: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const groups = kind === "settings" ? PERSONAL_NAV : kind === "admin" ? ADMIN_NAV : PLATFORM_NAV;
  const visible = groups.map((group) => ({ ...group, items: group.items.filter((item) => !item.permission || permissions.includes(item.permission)) })).filter((group) => group.items.length);
  function close() { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }
  function content(mobile = false) { return <>
    <div className="mgmt-sidebar-top">
      <Button type="button" variant="ghost" className="mgmt-back" onClick={onBack}><span aria-hidden="true">←</span><span>Back to workspace</span></Button>
      {kind !== "platform" ? <label className="mgmt-org-switcher"><Building2 aria-hidden /><span>Organization</span><FormSelect value={activeOrganizationId} onChange={onOrganizationChange} options={organizations.map((organization) => ({ value: organization.id, label: organization.name }))} /></label> : <div className="mgmt-environment"><ShieldCheck aria-hidden /><span>Platform console</span><b>Production</b></div>}
    </div>
    <nav aria-label={kind === "settings" ? "Personal settings" : kind === "admin" ? "Organization administration" : "Platform administration"}>
      {visible.map((group) => <section key={group.label || "overview"} className="mgmt-nav-group">{group.label ? <h2>{group.label}</h2> : null}{group.items.map((item) => { const Icon = item.icon; return <Button key={item.id} variant="ghost" type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => { onNavigate(kind, item.id); if (mobile) close(); }}><Icon aria-hidden /><span>{item.label}</span></Button>; })}</section>)}
      {kind === "settings" && (ADMIN_NAV.some((group) => group.items.some((item) => !item.permission || permissions.includes(item.permission))) || platformAuthorized) ? <section className="mgmt-nav-group mgmt-admin-link"><h2>Administration</h2>{ADMIN_NAV.some((group) => group.items.some((item) => !item.permission || permissions.includes(item.permission))) ? <Button variant="ghost" type="button" onClick={() => onNavigate("admin", "overview")}><ShieldCheck aria-hidden /><span>Open admin console</span><SquareArrowOutUpRight aria-hidden className="mgmt-nav-external" /></Button> : null}{platformAuthorized ? <Button variant="ghost" type="button" onClick={() => onNavigate("platform", "overview")}><Building2 aria-hidden /><span>Open platform console</span><SquareArrowOutUpRight aria-hidden className="mgmt-nav-external" /></Button> : null}</section> : null}
    </nav>
  </>; }
  return <>
    <Button ref={triggerRef} variant="ghost" size="icon" type="button" className="mgmt-mobile-trigger" onClick={() => setOpen(true)} aria-label="Open management navigation" aria-expanded={open}><Menu /></Button>
    <aside className="mgmt-sidebar">{content()}</aside>
    {open ? <div className="mgmt-mobile-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside role="dialog" aria-modal="true" className="mgmt-mobile-sheet" aria-label="Management navigation" onKeyDown={(event) => { if (event.key === "Escape") close(); }}><Button autoFocus variant="ghost" size="icon" className="mgmt-sheet-close" onClick={close} aria-label="Close navigation"><X /></Button>{content(true)}</aside></div> : null}
  </>;
}
