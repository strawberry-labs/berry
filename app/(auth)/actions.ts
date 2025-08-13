'use server';
import { signIn, signOut } from './auth';

// For Email Magic Link
export const emailMagicLink = async (email: string) => {
  await signOut({redirect:false})
  await signIn('nodemailer', {email, redirect:false});
  return { status: 'success' };
};

// For OAuth
export const oauthSignIn = async (provider: 'github' | 'google' | 'apple') => {
  await signOut({redirect:false})
  await signIn(provider);
  return { status: 'success' };
};