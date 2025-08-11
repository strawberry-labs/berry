import NextAuth, { NextAuthConfig, type DefaultSession } from 'next-auth';
import Google from "next-auth/providers/google"
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/lib/db/db';
import { verificationTokens, user, accounts } from '@/lib/db/schema';
// import { createGuestUser } from '@/lib/db/queries';

export type UserType = 'guest' | 'regular' | 'internal';

export type UserRole = 'user' | 'admin'

export type UserRoleWithGuest = UserRole | 'guest'

declare module 'next-auth' {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
      role: UserRole
    } & DefaultSession['user'];
  }

  interface User {
    id?: string;
    email?: string | null;
    type: UserType;
    role: UserRole;
  }
}

export const authConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: user,
    accountsTable: accounts,
    verificationTokensTable: verificationTokens,
  }), 
  providers: [
    Google,GitHub
  ], 
  session:{
    strategy:"jwt"
  },
  callbacks:{
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.type = user.type || "regular";
        token.role = user.role || 'guest';
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.type = token.type as UserType;
        session.user.role = token.role as UserRole
      }
      return session;
    },
    // async redirect({ url, baseUrl }) {
    //   return url.startsWith(baseUrl) ? url : baseUrl + "/login";
    // },
    async signIn({user, account, profile, email, credentials}){
      const session = await auth();
      console.log("session", session)
      console.log("user", user)
      console.log("account", account)
      console.log("profile", profile)
      console.log("email", email)
      console.log("credentials", credentials)
      return true
    },
  },
  pages: {
    signIn: "/login",
    error: "/login?error=failed",
  },
  secret: process.env.AUTH_SECRET,
} satisfies NextAuthConfig

export const {
  handlers,
  auth,
  signIn,
  signOut,
} = NextAuth(authConfig);