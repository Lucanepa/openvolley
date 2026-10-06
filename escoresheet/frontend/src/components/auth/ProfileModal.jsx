import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { PROFILE_NOT_SAVED } from './profileWrite'
import { X } from 'lucide-react'
import { Button, cn, Field, FOCUS_RING, IconButton, Input } from '../../ui'

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
      setError(updateError.code === PROFILE_NOT_SAVED
        ? t('auth.profileNotSaved', 'Your profile was not saved. Please reload the app and try again.')
        : updateError.message)
    } else {
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    }
    setLoading(false)
  }

  const labelCls = 'mb-1.5 block text-sm font-medium text-stone-700'

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-modal-title"
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-5 py-2 sm:px-6">
          <h2 id="profile-modal-title" className="text-lg font-bold text-stone-900">
            {t('auth.profile', 'Profile')}
          </h2>
          <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} className="-mr-2" />
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          {error && (
            <p role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {success && (
            <p className="mb-4 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
              {t('auth.profileUpdated', 'Profile updated successfully')}
            </p>
          )}

          {/* Email */}
          <div className="mb-4">
            <label htmlFor={isEditingEmail ? 'profile-new-email' : undefined} className={labelCls}>
              {t('auth.email', 'Email')}
            </label>

            {emailSuccess && (
              <p className="mb-2 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-700">
                {t('auth.emailChangeConfirmation', 'Check your new email to confirm the change')}
              </p>
            )}

            {emailError && (
              <p role="alert" className="mb-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                {emailError}
              </p>
            )}

            {isEditingEmail ? (
              <div className="flex gap-2">
                <Input
                  id="profile-new-email"
                  size="lg"
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  placeholder={t('auth.newEmail', 'New email address')}
                  aria-label={t('auth.newEmail', 'New email address')}
                  className="min-w-0 flex-1"
                  autoFocus
                />
                <Button
                  variant="dark"
                  size="xl"
                  onClick={handleEmailChange}
                  disabled={emailLoading || !newEmail}
                  loading={emailLoading}
                  className="shrink-0 whitespace-nowrap rounded-lg font-medium"
                >
                  {emailLoading ? '...' : t('auth.save', 'Save')}
                </Button>
                <Button
                  variant="secondary"
                  size="xl"
                  onClick={() => {
                    setIsEditingEmail(false)
                    setNewEmail('')
                    setEmailError('')
                  }}
                  className="shrink-0 rounded-lg font-medium"
                >
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex h-11 min-w-0 flex-1 items-center truncate rounded-xl border border-stone-200 bg-stone-50 px-3 text-base text-stone-600">
                  {user?.email}
                </div>
                <Button
                  variant="secondary"
                  size="xl"
                  onClick={() => setIsEditingEmail(true)}
                  className="shrink-0 rounded-lg font-medium"
                >
                  {t('auth.change', 'Change')}
                </Button>
              </div>
            )}
          </div>

          {/* Role (read-only) */}
          <div className="mb-4">
            <div className={labelCls}>
              {t('auth.roles', 'Role')}
            </div>
            <div className="flex gap-1.5">
              <span className="inline-flex items-center whitespace-nowrap rounded border border-emerald-200 bg-emerald-50 px-1.5 py-[3px] text-[11px] font-semibold leading-none text-emerald-700">
                {t('auth.roleScorer', 'Scorer')}
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Name fields */}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('auth.firstName', 'First name')}>
                <Input
                  size="lg"
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  aria-label={t('auth.firstName', 'First name')}
                  autoComplete="given-name"
                />
              </Field>
              <Field label={t('auth.lastName', 'Last name')}>
                <Input
                  size="lg"
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  aria-label={t('auth.lastName', 'Last name')}
                  autoComplete="family-name"
                />
              </Field>
            </div>

            {/* Country and DOB */}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('auth.country', 'Country')}>
                <Input
                  size="lg"
                  type="text"
                  value={country}
                  onChange={e => setCountry(e.target.value.toUpperCase())}
                  placeholder="CHE"
                  maxLength={3}
                  aria-label={t('auth.country', 'Country')}
                  className="uppercase"
                />
              </Field>
              <Field label={t('auth.dob', 'Date of birth')}>
                <Input
                  size="lg"
                  type="date"
                  value={dob}
                  onChange={e => setDob(e.target.value)}
                  aria-label={t('auth.dob', 'Date of birth')}
                />
              </Field>
            </div>

            <button
              type="submit"
              disabled={!hasChanges || loading}
              aria-busy={loading || undefined}
              className={cn(
                'inline-flex !mt-5 h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed',
                success ? 'bg-emerald-700' : 'bg-red-600 hover:bg-red-700 disabled:bg-stone-300',
                loading && 'opacity-70',
                FOCUS_RING
              )}
            >
              {loading
                ? t('auth.saving', 'Saving...')
                : success
                  ? t('auth.infoSaved', 'Info saved')
                  : t('auth.saveProfile', 'Save profile')}
            </button>
          </form>


          {/* Danger Zone - Delete Account */}
          <div className="mt-6 rounded-xl border border-red-100 bg-red-50/60 p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-red-700">
              {t('auth.dangerZone', 'Danger zone')}
            </div>
            <p className="mt-1 mb-3 text-sm text-stone-600">
              {t('auth.deleteAccountWarning', 'Deleting your account is permanent and cannot be undone.')}
            </p>
            <Button
              variant="danger-outline"
              size="xl"
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-lg bg-white font-medium"
            >
              {t('auth.deleteAccount', 'Delete account')}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-stone-900/60 p-4 backdrop-blur-sm"
          style={{ zIndex: 2100 }}
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="profile-delete-title"
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="profile-delete-title" className="text-lg font-bold text-stone-900">
              {t('auth.confirmDeleteAccount', 'Confirm account deletion')}
            </h3>

            <p className="mt-2 mb-4 text-sm text-stone-600">
              {t('auth.deleteAccountConfirmMessage', 'This action is permanent. All your data will be deleted.')}
            </p>

            <label htmlFor="profile-delete-email" className="mb-1 block text-sm font-medium text-stone-700">
              {t('auth.typeEmailToConfirm', 'Type your email to confirm:')}
            </label>
            <p className="mb-2 font-mono text-xs text-stone-500">
              {user?.email}
            </p>

            {deleteError && (
              <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                {deleteError}
              </p>
            )}

            <Input
              id="profile-delete-email"
              size="lg"
              type="email"
              value={deleteEmailInput}
              onChange={e => setDeleteEmailInput(e.target.value)}
              placeholder={user?.email}
              aria-label={t('auth.typeEmailToConfirm', 'Type your email to confirm:')}
              className="text-sm"
            />

            <div className="mt-6 flex gap-2">
              <Button
                variant="secondary"
                size="xl"
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 rounded-lg font-medium"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="danger"
                size="xl"
                onClick={handleDeleteAccount}
                disabled={deleteLoading || deleteEmailInput !== user?.email}
                className={cn('flex-1 rounded-lg', deleteLoading && 'opacity-70')}
              >
                {deleteLoading
                  ? t('auth.deleting', 'Deleting...')
                  : t('auth.deleteAccountConfirm', 'Delete my account')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
