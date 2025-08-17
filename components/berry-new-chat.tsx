"use client"

import * as React from "react"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { BerryIcon, PlusIcon } from "./icons"
import { SquarePen } from "lucide-react"
import { useRouter } from "next/navigation"

export function BerryNewChat() {
  const router = useRouter();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground transition-all duration-200 relative group/button cursor-pointer"
              onClick={
                ()=>{
                  router.push('/');
                  router.refresh();
                }
              }
            >
              <div className="bg-none text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg transition-all duration-200 absolute top-1/2 -translate-y-1/2 group-data-[collapsible=icon]:left-0">
                <BerryIcon size={21}/>
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:invisible absolute left-10">
                <span className="text-lg font-semibold text-sidebar-foreground group-hover/button:text-sidebar-foreground">
                  Berry
                </span>
              </div>
              <div className="ml-auto transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:invisible group-hover/button:text-primary">
                <PlusIcon />
              </div>
            </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}