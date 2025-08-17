"use client"

import {
  ChevronsUpDown,
  LogIn,
  LogOut,
  Palette,
} from "lucide-react"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { User } from "next-auth"
import { useRouter } from "next/navigation"
import { signOut } from "next-auth/react"
import { useTheme } from "next-themes"

export function NavUser({
  user,
  isGuest
}: {
  user:User|undefined
  isGuest:boolean
}) {
  const { isMobile } = useSidebar()

  const router = useRouter()
  const { setTheme, resolvedTheme } = useTheme();


  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent transition-all duration-200 relative hover:text-current focus:text-current cursor-pointer"
            >
              <Avatar className="h-8 w-8 rounded-lg transition-all duration-200 absolute top-1/2 -translate-y-1/2 group-data-[collapsible=icon]:left-0">
                <AvatarImage src={user?.image || undefined} alt={user?.name || undefined} />
                <AvatarFallback className="rounded-lg">{user?.name?.split(" ").slice(0, 2).map((name)=>name.charAt(0).toUpperCase()).join("")}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:invisible absolute left-[2.875rem]">
                <span className="truncate font-medium">{user?.name || ""}</span>
                {!isGuest&&<span className="truncate text-xs">{user?.email || ""}</span>}
              </div>
              <ChevronsUpDown className="ml-auto size-4  transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:invisible" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage src={user?.image || undefined} alt={user?.name || undefined} />
                  <AvatarFallback className="rounded-lg">{user?.name?.split(" ").map((name)=>name.charAt(0).toUpperCase()).join("")}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user?.name || ""}</span>
                  {!isGuest && <span className="truncate text-xs">{user?.email || ""}</span>}
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* <DropdownMenuGroup>
              <DropdownMenuItem>
                <Sparkles />
                Upgrade to Pro
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <BadgeCheck />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem>
                <CreditCard />
                Billing
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Bell />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup> */}
              <DropdownMenuItem onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} className="cursor-pointer">
                <Palette/>
               <span> {`Toggle ${resolvedTheme === 'light' ? 'dark' : 'light'} mode`}</span>
              </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={async ()=>{
                if (isGuest) {
                  router.push('/login');
                } else {
                  await signOut({
                    redirectTo: '/login',
                  });
                }
            }} className="cursor-pointer">
              {isGuest
              ?
              <>
              <LogIn />
              <span>Log in</span>
              </>
              :
              <>
              <LogOut />
              <span>Log out</span>
              </>
              }
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
