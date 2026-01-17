/**
 * AdminLogin component - Login form for admin authentication.
 * Validates email format and password length before submission.
 * Provides visual feedback for validation errors and loading states.
 * @module routes/admin/components/AdminLogin
 */

import { useState } from 'react'
import { adminLogin, type AdminUser } from '../../../services/api'

/**
 * Props for the AdminLogin component.
 */
interface AdminLoginProps {
  /** Callback when login succeeds with user data */
  onLogin: (user: AdminUser) => void
}

/**
 * Validation state for form fields.
 */
interface TouchedState {
  email: boolean
  password: boolean
}

/**
 * Login form component for admin authentication.
 * Validates email format and password length before submission.
 *
 * @param props - Component props
 * @param props.onLogin - Callback when login succeeds with user data
 */
export function AdminLogin({ onLogin }: AdminLoginProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [touched, setTouched] = useState<TouchedState>({
    email: false,
    password: false,
  })

  /** Check if email has valid format */
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  /** Check if password meets minimum length */
  const passwordValid = password.length >= 6
  /** Form is valid when both fields pass validation */
  const formValid = emailValid && passwordValid

  /**
   * Returns email validation error message, if any.
   * Returns null if field has not been touched or is valid.
   */
  const getEmailError = (): string | null => {
    if (!touched.email) return null
    if (!email) return 'Email is required'
    if (!emailValid) return 'Please enter a valid email address'
    return null
  }

  /**
   * Returns password validation error message, if any.
   * Returns null if field has not been touched or is valid.
   */
  const getPasswordError = (): string | null => {
    if (!touched.password) return null
    if (!password) return 'Password is required'
    if (!passwordValid) return 'Password must be at least 6 characters'
    return null
  }

  /**
   * Handles form submission - validates and attempts login.
   * Sets all fields as touched to show validation errors if form is invalid.
   *
   * @param e - Form submit event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched({ email: true, password: true })

    if (!formValid) return

    setError(null)
    setLoading(true)

    try {
      const { user } = await adminLogin(email, password, rememberMe)
      onLogin(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const emailError = getEmailError()
  const passwordError = getPasswordError()

  return (
    <div className="admin-login">
      <div className="login-card">
        <h1>Admin Dashboard</h1>
        <p className="subtitle">Sign in to manage your data</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className={`form-group ${emailError ? 'has-error' : ''}`}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              placeholder="admin@scaleai.local"
              className={emailError ? 'input-error' : ''}
            />
            {emailError && <span className="field-error">{emailError}</span>}
          </div>

          <div className={`form-group ${passwordError ? 'has-error' : ''}`}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              placeholder="Enter password"
              className={passwordError ? 'input-error' : ''}
            />
            {passwordError && <span className="field-error">{passwordError}</span>}
          </div>

          <div className="form-group-checkbox">
            <label>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>Remember me for 30 days</span>
            </label>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="login-hint">
          Default: <code>admin@scaleai.local</code> / <code>admin123</code>
        </div>
      </div>
    </div>
  )
}
