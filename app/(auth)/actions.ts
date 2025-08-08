'use server';
import { signIn } from './auth';

// For Email Magic Link
export const emailMagicLink = async (email: string) => {
  await signIn('email', { email, redirect: false });
  return { status: 'success' };
};

// For OAuth
export const oauthSignIn = async (provider: 'github' | 'google' | 'apple') => {
  await signIn(provider, { redirect: true, redirectTo: "/" });
  return { status: 'success' };
};