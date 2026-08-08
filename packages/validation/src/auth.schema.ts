import { z } from 'zod';
import {
  birthDateSchema,
  countryCodeSchema,
  displayNameSchema,
  emailSchema,
  languageCodeSchema,
  localeSchema,
  passwordSchema,
  usernameSchema,
} from './primitives.js';

/** Registration. Terms acceptance is a required boolean literal rather than a checkbox
 *  value, so a client cannot register someone by omitting the field. */
export const registerSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    displayName: displayNameSchema.optional(),
    password: passwordSchema,
    confirmPassword: z.string(),
    birthDate: birthDateSchema,
    country: countryCodeSchema,
    locale: localeSchema.default('en'),
    languages: z.array(languageCodeSchema).min(1).max(5).default(['en']),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the Terms of Service' }),
    }),
    acceptedGuidelines: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the Community Guidelines' }),
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => !data.password.toLowerCase().includes(data.username.toLowerCase()), {
    message: 'Password must not contain your username',
    path: ['password'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  /** Not `passwordSchema`: an existing password predates any policy change, and applying
   *  the policy at login would lock users out and leak which accounts have weak ones. */
  password: z.string().min(1, 'Enter your password').max(128),
  rememberMe: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  /** Omitted by web clients, which send the refresh token as an HttpOnly cookie. */
  refreshToken: z.string().min(20).max(2000).optional(),
});

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(500),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(500) });

export const resendVerificationSchema = z.object({ email: emailSchema });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'Choose a password you have not used before',
    path: ['newPassword'],
  });

export const oauthCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  /** CSRF defence for the OAuth redirect; compared against the signed state cookie. */
  state: z.string().min(1).max(500),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
});
