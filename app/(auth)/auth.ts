import NextAuth, { type NextAuthConfig, type DefaultSession } from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';
import Apple from 'next-auth/providers/apple';
import Google from 'next-auth/providers/google';
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
        port: process.env.EMAIL_SERVER_PORT ? Number(process.env.EMAIL_SERVER_PORT) : undefined,
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      },
      from: process.env.EMAIL_FROM,
      async sendVerificationRequest({ identifier: email, url, provider }) {
        const { createTransport } = await import('nodemailer');
        const transport = createTransport(provider.server);

        const emailTemplate = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Login Link</title>
    <style>
      /* For clients that support <style> */
      @media (max-width:600px){
        .container{width:100%!important}
        .p-24{padding:20px!important}
        .btn{width:100%!important}
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <!-- Card -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="max-width:600px;width:600px;background:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.04);">
            <tr>
              <td class="p-24" style="padding:32px 32px 28px 32px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
                
                <!-- Logo -->
                <div style="margin-bottom:20px;">
                  <img src="https://cdn.strawberrylabs.net/strawberrylabs/berry-logo.png" alt="Berry" style="height:32px;width:auto;" />
                </div>

                <!-- Heading -->
                <h1 style="margin:0 0 10px 0;font-size:28px;line-height:1.25;font-weight:700;color:#0f172a;">
                  Let's log you in
                </h1>

                <!-- Subtext -->
                <p style="margin:0 0 28px 0;font-size:16px;line-height:1.6;color:#334155;">
                  Click the button below to login to Berry.
                  <br/>This button will expire in 20 minutes
                </p>

                <!-- Button -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td>
                      <a href="${url}"
                         class="btn"
                         style="background:#DA1D54;border-radius:8px;color:#ffffff;display:inline-block;font-size:16px;font-weight:700;line-height:48px;text-align:center;text-decoration:none;padding:0 28px;min-width:160px;">
                        Login
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Confirmation line -->
                <p style="margin:0 0 28px 0;font-size:16px;line-height:1.6;color:#334155;">
                  Confirming this request will securely
                  log you in using
                  <a href="mailto:${email}" style="color:#DA1D54;text-decoration:underline;">${email}</a>
                </p>

                <!-- Footer note -->
                <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">
                  If you didn't request this email, you can safely ignore it.
                </p>

              </td>
            </tr>
          </table>
          <!-- /Card -->
        </td>
      </tr>
    </table>
  </body>
</html>`;

        await transport.sendMail({
          to: email,
          from: provider.from,
          subject: 'Login to Berry',
          html: emailTemplate,
        });
      },
    }),
    Apple({ allowDangerousEmailAccountLinking: true }),
    Google({ allowDangerousEmailAccountLinking: true }),
    GitHub({ allowDangerousEmailAccountLinking: true }),
    Credentials({
      id: 'guest',
      credentials: {},
      async authorize() {
        const [guestUser] = await createGuestUser();
        return { ...guestUser, type: 'guest' };
      },
    }),
  ],
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (trigger && trigger === 'update' && session?.name) {
        token.name = session.name;
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
        session.user.name = token.name;
      }
      return session;
    },
    async signIn({ user, account, profile, email, credentials }) {
      const session = await auth();

      if (session) {
        await signOut({ redirect: false });
      }

      if (account && account.provider === 'google') {
        if (profile && !profile.email_verified) {
          return false;
        }
      }

      return true;
    },
  },
  pages: {
    signIn: '/login',
    error: '/login?error=failed',
  },
  secret: process.env.AUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
