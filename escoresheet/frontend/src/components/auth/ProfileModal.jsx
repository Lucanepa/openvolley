import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'

export default function ProfileModal({ open, onClose }) {
  const { t } = useTranslation()
  const { user, profile, updateProfile, updateEmail, deleteAccount } = useAuth()

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [country, setCountry] = useState('CHE')
  const [dob, setDob] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // Email change state
  const [isEditingEmail, setIsEditingEmail] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailSuccess, setEmailSuccess] = useState(false)
  const [emailError, setEmailError] = useState('')

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteEmailInput, setDeleteEmailInput] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Track if form has been initialized to avoid resetting on profile refetch
  const formInitialized = useRef(false)

  // Load profile data when modal opens OR when profile arrives (for late-loading profiles)
  useEffect(() => {
    console.log('[ProfileModal] useEffect triggered:', { open, profile, formInitialized: formInitialized.current })

    // Reset initialization flag when modal closes
    if (!open) {
      formInitialized.current = false
      return
    }

    // If modal is open and we have profile data, populate the form
    if (open && profile && !formInitialized.current) {
      if (import.meta.env.DEV) console.log('[ProfileModal] Loading profile data into form:', profile)
      setFirstName(profile.first_name || '')
      setLastName(profile.last_name || '')
      setCountry(profile.country || 'CHE')
      setDob(profile.dob || '')
      setError('')
      setSuccess(false)
      // Reset email change state
      setIsEditingEmail(false)
      setNewEmail('')
      setEmailError('')
      setEmailSuccess(false)
      // Reset delete state
      setShowDeleteConfirm(false)
      setDeleteEmailInput('')
      setDeleteError('')
      formInitialized.current = true
    } else if (open && !profile) {
      console.warn('[ProfileModal] Modal opened but profile is null/undefined - will update when profile loads')
    }
  }, [open, profile])

  const handleEmailChange = async () => {
    if (!newEmail || newEmail === user?.email) {
      setEmailError(t('auth.enterNewEmail', 'Please enter a new email address'))
      return
    }

    setEmailLoading(true)
    setEmailError('')

    const { error: emailErr } = await updateEmail(newEmail)

    if (emailErr) {
      setEmailError(emailErr.message)
    } else {
      setEmailSuccess(true)
      setIsEditingEmail(false)
    }
    setEmailLoading(false)
  }

  const handleDeleteAccount = async () => {
    if (deleteEmailInput !== user?.email) {
      setDeleteError(t('auth.emailDoesNotMatch', 'Email does not match'))
      return
    }

    setDeleteLoading(true)
    setDeleteError('')

    const { error: delError } = await deleteAccount()

    if (delError) {
      setDeleteError(delError.message)
      setDeleteLoading(false)
    } else {
      // Account deleted, close modal
      onClose()
    }
  }

  if (!open) return null

  // Check if any field has changed
  const hasChanges =
    firstName !== (profile?.first_name || '') ||
    lastName !== (profile?.last_name || '') ||
    country !== (profile?.country || 'CHE') ||
    dob !== (profile?.dob || '')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess(false)
    setLoading(true)

    const { error: updateError } = await updateProfile({
      firstName,
      lastName,
      country,
      dob: dob || null,
      roles: profile?.roles || ['scorer']
    })

    if (updateError) {
      setError(updateError.message)
    } else {
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    }
    setLoading(false)
  }

  const modalStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000
  }

  const contentStyle = {
    width: 'min(90vw, 440px)',
    maxHeight: '90vh',
    background: 'var(--panel)',
    border: '2px solid #3b82f6',
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  }

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    background: 'rgba(59, 130, 246, 0.1)',
    borderBottom: '1px solid rgba(59, 130, 246, 0.3)'
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 16px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text)',
    fontSize: 16,
    outline: 'none',
    boxSizing: 'border-box'
  }

  const buttonStyle = {
    width: '100%',
    padding: '12px 16px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 16,
    cursor: 'pointer'
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={contentStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, color: 'var(--text)', fontSize: 20, fontWeight: 600 }}>
            {t('auth.profile', 'Profile')}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              fontSize: 24,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1
            }}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto' }}>
          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: 8,
              color: '#ef4444',
              marginBottom: 16,
              fontSize: 14
            }}>
              {error}
            </div>
          )}

          {success && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              borderRadius: 8,
              color: '#22c55e',
              marginBottom: 16,
              fontSize: 14
            }}>
              {t('auth.profileUpdated', 'Profile updated successfully')}
            </div>
          )}

          {/* Email */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
              {t('auth.email', 'Email')}
            </label>

            {emailSuccess && (
              <div style={{
                padding: '10px 14px',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                borderRadius: 8,
                color: '#22c55e',
                marginBottom: 8,
                fontSize: 13
              }}>
                {t('auth.emailChangeConfirmation', 'Check your new email to confirm the change')}
              </div>
            )}

            {emailError && (
              <div style={{
                padding: '10px 14px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 8,
                color: '#ef4444',
                marginBottom: 8,
                fontSize: 13
              }}>
                {emailError}
              </div>
            )}

            {isEditingEmail ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  placeholder={t('auth.newEmail', 'New email address')}
                  style={{ ...inputStyle, flex: 1 }}
                  autoFocus
                />
                <button
                  onClick={handleEmailChange}
                  disabled={emailLoading || !newEmail}
                  style={{
                    padding: '12px 16px',
                    background: (!newEmail || emailLoading) ? '#4b5563' : '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 500,
                    cursor: (!newEmail || emailLoading) ? 'not-allowed' : 'pointer',
                    fontSize: 14,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {emailLoading ? '...' : t('auth.save', 'Save')}
                </button>
                <button
                  onClick={() => {
                    setIsEditingEmail(false)
                    setNewEmail('')
                    setEmailError('')
                  }}
                  style={{
                    padding: '12px 16px',
                    background: 'var(--panel-2)',
                    color: 'var(--text)',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 14
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{
                  ...inputStyle,
                  flex: 1,
                  background: 'var(--panel-2)',
                  color: 'var(--muted)'
                }}>
                  {user?.email}
                </div>
                <button
                  onClick={() => setIsEditingEmail(true)}
                  style={{
                    padding: '12px 16px',
                    background: 'transparent',
                    color: '#3b82f6',
                    border: '1px solid #3b82f6',
                    borderRadius: 8,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 14
                  }}
                >
                  {t('auth.change', 'Change')}
                </button>
              </div>
            )}
          </div>

          {/* Role (read-only) */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
              {t('auth.roles', 'Role')}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <span
                style={{
                  padding: '6px 12px',
                  background: '#22c55e',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: 13
                }}
              >
                {t('auth.roleScorer', 'Scorer')}
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Name fields */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
                  {t('auth.firstName', 'First name')}
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
                  {t('auth.lastName', 'Last name')}
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Country and DOB */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
                  {t('auth.country', 'Country')}
                </label>
                <input
                  type="text"
                  value={country}
                  onChange={e => setCountry(e.target.value.toUpperCase())}
                  placeholder="CHE"
                  maxLength={3}
                  style={{ ...inputStyle, textTransform: 'uppercase' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, display: 'block' }}>
                  {t('auth.dob', 'Date of birth')}
                </label>
                <input
                  type="date"
                  value={dob}
                  onChange={e => setDob(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>

            <button
              type="submit"
              style={{
                ...buttonStyle,
                background: success ? '#22c55e' : (!hasChanges ? '#4b5563' : '#3b82f6'),
                cursor: (!hasChanges || loading) ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1
              }}
              disabled={!hasChanges || loading}
            >
              {loading
                ? t('auth.saving', 'Saving...')
                : success
                  ? t('auth.infoSaved', 'Info saved')
                  : t('auth.saveProfile', 'Save Profile')}
            </button>
          </form>


          {/* Danger Zone - Delete Account */}
          <div style={{
            marginTop: 24,
            padding: '16px',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 8
          }}>
            <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: 8 }}>
              {t('auth.dangerZone', 'Danger Zone')}
            </div>
            <p style={{ color: '#fca5a5', fontSize: 13, marginBottom: 12 }}>
              {t('auth.deleteAccountWarning', 'Deleting your account is permanent and cannot be undone.')}
            </p>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              style={{
                padding: '10px 16px',
                background: 'transparent',
                color: '#ef4444',
                border: '1px solid #ef4444',
                borderRadius: 6,
                fontWeight: 500,
                cursor: 'pointer',
                fontSize: 14
              }}
            >
              {t('auth.deleteAccount', 'Delete Account')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2100
          }}
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            style={{
              width: 'min(90vw, 400px)',
              background: 'var(--panel)',
              border: '2px solid #ef4444',
              borderRadius: 12,
              overflow: 'hidden'
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: '16px 20px',
              background: 'rgba(239, 68, 68, 0.15)',
              borderBottom: '1px solid rgba(239, 68, 68, 0.3)'
            }}>
              <h3 style={{ margin: 0, color: '#ef4444', fontSize: 18, fontWeight: 600 }}>
                {t('auth.confirmDeleteAccount', 'Confirm Account Deletion')}
              </h3>
            </div>

            {/* Body */}
            <div style={{ padding: 20 }}>
              <p style={{ color: '#fca5a5', fontSize: 14, marginBottom: 16 }}>
                {t('auth.deleteAccountConfirmMessage', 'This action is permanent. All your data will be deleted.')}
              </p>

              <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
                {t('auth.typeEmailToConfirm', 'Type your email to confirm:')}
              </p>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8, fontFamily: 'monospace' }}>
                {user?.email}
              </p>

              {deleteError && (
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 8,
                  color: '#ef4444',
                  marginBottom: 12,
                  fontSize: 14
                }}>
                  {deleteError}
                </div>
              )}

              <input
                type="email"
                value={deleteEmailInput}
                onChange={e => setDeleteEmailInput(e.target.value)}
                placeholder={user?.email}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  color: 'var(--text)',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 16
                }}
              />

              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  style={{
                    flex: 1,
                    padding: '12px 16px',
                    background: 'var(--panel-2)',
                    color: 'var(--text)',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 14
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteLoading || deleteEmailInput !== user?.email}
                  style={{
                    flex: 1,
                    padding: '12px 16px',
                    background: deleteEmailInput === user?.email ? '#ef4444' : '#4b5563',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: deleteEmailInput === user?.email ? 'pointer' : 'not-allowed',
                    fontSize: 14,
                    opacity: deleteLoading ? 0.7 : 1
                  }}
                >
                  {deleteLoading
                    ? t('auth.deleting', 'Deleting...')
                    : t('auth.deleteAccountConfirm', 'Delete My Account')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
