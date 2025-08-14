import NextAuth, { NextAuthConfig, type DefaultSession } from 'next-auth';
import Nodemailer from "next-auth/providers/nodemailer"
import Apple from "next-auth/providers/apple"
import Google from "next-auth/providers/google"
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { verificationTokens, user, accounts } from '@/lib/db/schema';
import { createGuestUser } from '@/lib/db/queries';
import { db } from '@/lib/db/db';

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

export const authConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: user,
    accountsTable: accounts,
    verificationTokensTable: verificationTokens,
  }), 
  providers: [
    Nodemailer({
      server: {
        host: process.env.EMAIL_SERVER_HOST,
        port: process.env.EMAIL_SERVER_PORT,
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      },
      from: process.env.EMAIL_FROM,
    }),
    Apple({allowDangerousEmailAccountLinking:true}),
    Google({allowDangerousEmailAccountLinking:true}),
    GitHub({allowDangerousEmailAccountLinking:true}),
    Credentials({
      id: 'guest',
      credentials: {},
      async authorize() {
        const [guestUser] = await createGuestUser();
        return { ...guestUser, type: 'guest' };
      },
    }),
  ],
  session:{
    strategy:"jwt"
  },
  callbacks:{
    async jwt({ token, user, trigger, session }) {
      if(trigger && trigger==="update" && session?.name){
        token.name = session.name
      }
      if (user) {
        token.id = user.id as string;
        token.type = user.type;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.type = token.type as UserType;
        session.user.name = token.name
      }
      return session;
    },
    async signIn({user, account, profile, email, credentials}){
      const session = await auth();

      if(session){
        await signOut({redirect:false})
      }

      if(account && account.provider==="google"){
        if(profile && !profile.email_verified){
          return false
        }
      }

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