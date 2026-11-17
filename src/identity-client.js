// Browser bundle exposing Netlify Identity to the single-file WalkthroughIQ app.
// Built by `npm run build:client` into public/vendor/identity.js.
import {
  login,
  logout,
  getUser,
  handleAuthCallback,
  acceptInvite,
  requestPasswordRecovery,
  updateUser,
  onAuthChange,
  AuthError,
  MissingIdentityError,
} from '@netlify/identity'

window.WIQAuth = {
  login,
  logout,
  getUser,
  handleAuthCallback,
  acceptInvite,
  requestPasswordRecovery,
  updateUser,
  onAuthChange,
  AuthError,
  MissingIdentityError,
}

window.dispatchEvent(new Event('wiq-auth-ready'))
