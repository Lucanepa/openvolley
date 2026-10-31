import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../Modal'
import SignaturePad from '../SignaturePad'
import RostersPanel from '../rosters/RostersPanel'
import { Button } from '../../ui/Button.jsx'
import { db } from '../../db/db'
import { saveMatchSignature } from '../../utils/saveSignature'
import { phoneSignContext, signatureUpdate, SLOT_OF_ROLE, PRE_MATCH_SIGNATURE_FIELD } from '../../domain/phoneSignature'
import { PRE_MATCH_ROLES, missingRolesOf } from '../../domain/preMatchSignatures'

// The scoring screen's pre-match signing (owner 2026-10-31): the coin toss no
// longer waits for the coach and captain signatures, so they sign during the
// warm-up, from the flashing "Missing signature" button of their team. The
// first serve of the match waits for all four (domain/preMatchSignatures).

// As the coin toss's sign buttons: emerald once signed ("done", not "selected")
const SIGNED_CLASS = 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-50'
const MISSING_CLASS = 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'

const personName = (p) => [p?.firstName ?? p?.first_name, p?.lastName ?? p?.last_name].filter(Boolean).join(' ').trim()
const captainOf = (players) => (players || []).find(p => p.isCaptain || p.captain) || null
const coachOf = (bench) => (bench || []).find(b => /coach/i.test(b?.role || '') && !/assistant/i.test(b?.role || '')) || null

/** Who signs for a team, as the button names them: "#7 Anna Muster", "Max Muster". */
function signerName(data, team, role) {
  if (role === 'captain') {
    const c = captainOf(team === 'home' ? data?.homePlayers : data?.awayPlayers)
    if (!c) return ''
    return [c.number != null && c.number !== '' ? `#${c.number}` : '', personName(c)].filter(Boolean).join(' ')
  }
  return personName(coachOf(team === 'home' ? data?.match?.bench_home : data?.match?.bench_away))
}

/**
 * One team's roster to check and its coach and captain buttons. Each
 * signature is saved (and queued for the cloud) when its pad is confirmed;
 * the Scoreboard's live query then drops the team's "Missing signature".
 *
 * @param {object} props
 * @param {object} props.data the Scoreboard's live match data
 * @param {'home'|'away'} props.team
 * @param {string} props.teamTitle "A · Short name", as the screen shows the team
 * @param {number|string} props.matchId
 * @param {() => void} props.onClose
 * @param {() => void} [props.onCorrectRoster] opens "Reopen roster" for the team
 */
export default function PreMatchSignDialog({ data, team, teamTitle, matchId, onClose, onCorrectRoster }) {
  const { t, i18n } = useTranslation()
  const [signing, setSigning] = useState(null) // 'coach' | 'captain' | null
  const match = data?.match
  const missing = missingRolesOf(match, team)
  const roleLabel = (role) => t(role === 'coach' ? 'coinToss.coach' : 'coinToss.captain')

  const phoneFor = (role) => {
    if (!role || !match) return null
    const slot = SLOT_OF_ROLE[`${team}-${role}`]
    return {
      slot,
      matchKey: match.seed_key || match.seedKey || null,
      gamePin: match.gamePin || null,
      context: phoneSignContext({
        match,
        slot,
        homeTeam: data.homeTeam,
        awayTeam: data.awayTeam,
        homeCaptain: captainOf(data.homePlayers),
        awayCaptain: captainOf(data.awayPlayers),
        homeCoach: coachOf(match.bench_home),
        awayCoach: coachOf(match.bench_away),
        lang: i18n.language,
        fallbackHome: t('common.home'),
        fallbackAway: t('common.away')
      })
    }
  }

  return (
    <>
      <Modal
        title={t('preMatchSignatures.dialogTitle', { team: teamTitle })}
        open={true}
        onClose={onClose}
        width={760}
        // a column: the roster scrolls, the buttons stay in view
        panelStyle={{ display: 'flex', flexDirection: 'column' }}
      >
        <div data-testid="pre-match-sign-dialog" data-team={team} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          <p className="text-sm text-stone-600" style={{ margin: '0 0 12px' }}>
            {missing.length > 0 ? t('preMatchSignatures.intro') : t('preMatchSignatures.allSigned')}
          </p>
          <RostersPanel data={data} lineups={{ home: null, away: null }} servingTeam={null} team={team} />
        </div>

        <div className="ov-kit" style={{ flexShrink: 0, paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {PRE_MATCH_ROLES.map(role => {
              const signed = !missing.includes(role)
              const name = signerName(data, team, role)
              return (
                <Button
                  key={role}
                  variant="secondary"
                  size="xl"
                  data-testid={`pre-match-sign-${role}`}
                  className={`h-auto min-h-14 flex-col gap-0.5 py-2 ${signed ? SIGNED_CLASS : MISSING_CLASS}`}
                  style={{ flex: '1 1 200px', minWidth: 0 }}
                  onClick={() => setSigning(role)}
                >
                  <span>{roleLabel(role)} {signed ? '✓' : `· ${t('preMatchSignatures.sign')}`}</span>
                  {name && <span className="max-w-full truncate text-xs font-normal">{name}</span>}
                </Button>
              )
            })}
          </div>
          <div className="border-t border-stone-200" style={{ display: 'flex', justifyContent: onCorrectRoster ? 'space-between' : 'flex-end', gap: 8, marginTop: 12, paddingTop: 12 }}>
            {onCorrectRoster && (
              <Button variant="secondary" size="xl" onClick={onCorrectRoster}>
                {t('preMatchSignatures.correctRoster')}
              </Button>
            )}
            <Button variant="dark" size="xl" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* The pad over the dialog. SignaturePad is the modal itself. */}
      <SignaturePad
        open={!!signing}
        zIndex={1100}
        title={signing ? t('roster.signatureTitle', { role: roleLabel(signing), team: teamTitle }) : ''}
        onClose={() => setSigning(null)}
        onSave={async (image, meta) => {
          const field = PRE_MATCH_SIGNATURE_FIELD[`${team}-${signing}`]
          await saveMatchSignature(db, matchId, field, image, signatureUpdate(field, image, meta))
          setSigning(null)
        }}
        phone={signing ? phoneFor(signing) : null}
      />
    </>
  )
}

/**
 * "Start set" in set 1 with signatures missing: who still has to sign, and a
 * way to each team's roster.
 *
 * @param {object} props
 * @param {Array<{ key: 'home'|'away', title: string, roles: string[] }>} props.teams the teams still missing one
 * @param {(team: 'home'|'away') => void} props.onSign
 * @param {() => void} props.onClose
 */
export function SignaturesMissingModal({ teams, onSign, onClose }) {
  const { t } = useTranslation()
  const roleLabel = (role) => t(role === 'coach' ? 'coinToss.coach' : 'coinToss.captain')
  return (
    <Modal title={t('preMatchSignatures.blockedTitle')} open={true} onClose={onClose} width={520}>
      <div data-testid="signatures-missing-modal" className="ov-kit">
        <p className="text-sm text-stone-700" style={{ margin: '0 0 16px' }}>{t('preMatchSignatures.blockedBody')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {teams.map(team => (
            <Button
              key={team.key}
              variant="secondary"
              size="xl"
              className={`h-auto min-h-14 justify-between py-2 text-left ${MISSING_CLASS}`}
              onClick={() => onSign(team.key)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{team.title}</span>
                <span className="text-xs font-normal">{t('preMatchSignatures.stillMissing', { roles: team.roles.map(roleLabel).join(', ') })}</span>
              </span>
              <span className="shrink-0">{t('preMatchSignatures.sign')}</span>
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="dark" size="xl" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * The flashing "Missing signature" button of a team on the scoring screen
 * (styles.css .missing-signature-button; steady under reduced motion).
 *
 * @param {object} props
 * @param {string[]} props.roles the roles still to sign
 * @param {string} [props.detail] the second line (default: the roles)
 * @param {() => void} props.onClick
 * @param {object} [props.style] the layout's sizes
 * @param {string} [props.testId]
 */
export function MissingSignatureButton({ roles, detail, onClick, style, testId }) {
  const { t } = useTranslation()
  const roleLabel = (role) => t(role === 'coach' ? 'coinToss.coach' : 'coinToss.captain')
  return (
    <button
      type="button"
      className="missing-signature-button"
      data-testid={testId}
      onClick={onClick}
      style={style}
    >
      <span className="missing-signature-title">{t('preMatchSignatures.missingButton', { count: roles.length })}</span>
      <span className="missing-signature-detail">{detail ?? roles.map(roleLabel).join(' · ')}</span>
    </button>
  )
}
