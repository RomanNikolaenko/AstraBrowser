import { Routes } from '@angular/router';
import { signedInGuard, signedOutGuard } from './shared/auth/auth';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'sign-in',
    canActivate: [signedOutGuard],
    loadComponent: () => import('./auth/sign-in/sign-in').then((module) => module.SignIn),
  },
  {
    path: 'sign-up',
    canActivate: [signedOutGuard],
    loadComponent: () => import('./auth/sign-up/sign-up').then((module) => module.SignUp),
  },
  {
    path: 'forgot-password',
    canActivate: [signedOutGuard],
    loadComponent: () => import('./auth/forgot-password/forgot-password').then((module) => module.ForgotPassword),
  },
  {
    path: 'home',
    canActivate: [signedInGuard],
    loadComponent: () => import('./browser/browser').then((module) => module.Browser),
  },
  { path: '**', redirectTo: 'home' },
];
