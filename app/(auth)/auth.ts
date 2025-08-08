import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/lib/db/db';
import { verificationTokens, user, accounts, sessions } from '@/lib/db/schema';

export type UserType = 'guest' | 'regular';

declare module 'next-auth' {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
    } & DefaultSession['user'];
  }

  interface User {
    id?: string;
    email?: string | null;
    type: UserType;
  }
}

export const {
  handlers,
  auth,
  signIn,
  signOut,
} = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: user,
    accountsTable: accounts,
    verificationTokensTable: verificationTokens,
    sessionsTable:sessions
  }), 
  providers: [
    GitHub,
  ],
  //   session: {
  //   strategy: "database", // Required for database sessions
  // },
  // debug: process.env.NODE_ENV === "development",
  secret: process.env.AUTH_SECRET,
  // callbacks: {
  //   async jwt({ token, user }) {
  //     if (user) {
  //       token.id = user.id as string;
  //       token.type = user.type || 'regular';
  //     }
  //     return token;
  //   },
  //   async session({ session, token }) {
  //     if (session.user) {
  //       session.user.id = token.id as string;
  //       session.user.type = token.type as UserType;
  //     }
  //     return session;
  //   },
  //  },
});