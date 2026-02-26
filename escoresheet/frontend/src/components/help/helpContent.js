// Static data mapping page names to FAQ arrays
// Each item: { questionKey, answerKey, helpId (nullable), tooltipKey }

export const helpContent = {
  home: [
    {
      questionKey: 'contextHelp.home.q_createMatch',
      answerKey: 'contextHelp.home.a_createMatch',
      helpId: 'home-new-match-button',
      tooltipKey: 'contextHelp.home.tip_createMatch'
    },
    {
      questionKey: 'contextHelp.home.q_officialVsTest',
      answerKey: 'contextHelp.home.a_officialVsTest',
      helpId: null,
      tooltipKey: null
    },
    {
      questionKey: 'contextHelp.home.q_continueMatch',
      answerKey: 'contextHelp.home.a_continueMatch',
      helpId: 'home-continue-button',
      tooltipKey: 'contextHelp.home.tip_continueMatch'
    },
    {
      questionKey: 'contextHelp.home.q_deleteMatch',
      answerKey: 'contextHelp.home.a_deleteMatch',
      helpId: 'home-delete-button',
      tooltipKey: 'contextHelp.home.tip_deleteMatch'
    },
    {
      questionKey: 'contextHelp.home.q_restoreMatch',
      answerKey: 'contextHelp.home.a_restoreMatch',
      helpId: 'home-restore-button',
      tooltipKey: 'contextHelp.home.tip_restoreMatch'
    },
    {
      questionKey: 'contextHelp.home.q_settings',
      answerKey: 'contextHelp.home.a_settings',
      helpId: null,
      tooltipKey: null
    }
  ],

  matchSetup: [
    {
      questionKey: 'contextHelp.matchSetup.q_matchInfo',
      answerKey: 'contextHelp.matchSetup.a_matchInfo',
      helpId: 'setup-match-info-card',
      tooltipKey: 'contextHelp.matchSetup.tip_matchInfo'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_teamColors',
      answerKey: 'contextHelp.matchSetup.a_teamColors',
      helpId: 'setup-home-team-card',
      tooltipKey: 'contextHelp.matchSetup.tip_teamColors'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_addPlayers',
      answerKey: 'contextHelp.matchSetup.a_addPlayers',
      helpId: 'setup-add-player',
      tooltipKey: 'contextHelp.matchSetup.tip_addPlayers'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_importPdf',
      answerKey: 'contextHelp.matchSetup.a_importPdf',
      helpId: 'setup-pdf-import',
      tooltipKey: 'contextHelp.matchSetup.tip_importPdf'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_liberos',
      answerKey: 'contextHelp.matchSetup.a_liberos',
      helpId: 'setup-libero-toggle',
      tooltipKey: 'contextHelp.matchSetup.tip_liberos'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_captain',
      answerKey: 'contextHelp.matchSetup.a_captain',
      helpId: 'setup-captain-toggle',
      tooltipKey: 'contextHelp.matchSetup.tip_captain'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_benchOfficials',
      answerKey: 'contextHelp.matchSetup.a_benchOfficials',
      helpId: 'setup-bench-officials',
      tooltipKey: 'contextHelp.matchSetup.tip_benchOfficials'
    },
    {
      questionKey: 'contextHelp.matchSetup.q_proceed',
      answerKey: 'contextHelp.matchSetup.a_proceed',
      helpId: 'setup-proceed-cointoss',
      tooltipKey: 'contextHelp.matchSetup.tip_proceed'
    }
  ],

  coinToss: [
    {
      questionKey: 'contextHelp.coinToss.q_record',
      answerKey: 'contextHelp.coinToss.a_record',
      helpId: 'cointoss-team-selector',
      tooltipKey: 'contextHelp.coinToss.tip_record'
    },
    {
      questionKey: 'contextHelp.coinToss.q_serve',
      answerKey: 'contextHelp.coinToss.a_serve',
      helpId: 'cointoss-serve-selector',
      tooltipKey: 'contextHelp.coinToss.tip_serve'
    },
    {
      questionKey: 'contextHelp.coinToss.q_sides',
      answerKey: 'contextHelp.coinToss.a_sides',
      helpId: 'cointoss-side-selector',
      tooltipKey: 'contextHelp.coinToss.tip_sides'
    },
    {
      questionKey: 'contextHelp.coinToss.q_start',
      answerKey: 'contextHelp.coinToss.a_start',
      helpId: 'cointoss-confirm-button',
      tooltipKey: 'contextHelp.coinToss.tip_start'
    }
  ],

  scoreboard: [
    {
      questionKey: 'contextHelp.scoreboard.q_startRally',
      answerKey: 'contextHelp.scoreboard.a_startRally',
      helpId: 'scoreboard-start-rally',
      tooltipKey: 'contextHelp.scoreboard.tip_startRally'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_awardPoint',
      answerKey: 'contextHelp.scoreboard.a_awardPoint',
      helpId: 'scoreboard-point-left',
      tooltipKey: 'contextHelp.scoreboard.tip_awardPoint'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_timeout',
      answerKey: 'contextHelp.scoreboard.a_timeout',
      helpId: 'scoreboard-timeout-left',
      tooltipKey: 'contextHelp.scoreboard.tip_timeout'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_substitution',
      answerKey: 'contextHelp.scoreboard.a_substitution',
      helpId: 'scoreboard-court-left',
      tooltipKey: 'contextHelp.scoreboard.tip_substitution'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_libero',
      answerKey: 'contextHelp.scoreboard.a_libero',
      helpId: 'scoreboard-bench-left',
      tooltipKey: 'contextHelp.scoreboard.tip_libero'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_undo',
      answerKey: 'contextHelp.scoreboard.a_undo',
      helpId: 'scoreboard-undo',
      tooltipKey: 'contextHelp.scoreboard.tip_undo'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_sanction',
      answerKey: 'contextHelp.scoreboard.a_sanction',
      helpId: 'scoreboard-court-right',
      tooltipKey: 'contextHelp.scoreboard.tip_sanction'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_lineup',
      answerKey: 'contextHelp.scoreboard.a_lineup',
      helpId: 'scoreboard-court-left',
      tooltipKey: 'contextHelp.scoreboard.tip_lineup'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_shortcuts',
      answerKey: 'contextHelp.scoreboard.a_shortcuts',
      helpId: null,
      tooltipKey: null
    },
    {
      questionKey: 'contextHelp.scoreboard.q_setEnd',
      answerKey: 'contextHelp.scoreboard.a_setEnd',
      helpId: 'scoreboard-score-display',
      tooltipKey: 'contextHelp.scoreboard.tip_setEnd'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_set5',
      answerKey: 'contextHelp.scoreboard.a_set5',
      helpId: 'scoreboard-set-display',
      tooltipKey: 'contextHelp.scoreboard.tip_set5'
    },
    {
      questionKey: 'contextHelp.scoreboard.q_changeDecision',
      answerKey: 'contextHelp.scoreboard.a_changeDecision',
      helpId: 'scoreboard-undo',
      tooltipKey: 'contextHelp.scoreboard.tip_changeDecision'
    }
  ],

  matchEnd: [
    {
      questionKey: 'contextHelp.matchEnd.q_reviewResults',
      answerKey: 'contextHelp.matchEnd.a_reviewResults',
      helpId: 'matchend-results-table',
      tooltipKey: 'contextHelp.matchEnd.tip_reviewResults'
    },
    {
      questionKey: 'contextHelp.matchEnd.q_signatures',
      answerKey: 'contextHelp.matchEnd.a_signatures',
      helpId: 'matchend-signatures',
      tooltipKey: 'contextHelp.matchEnd.tip_signatures'
    },
    {
      questionKey: 'contextHelp.matchEnd.q_exportPdf',
      answerKey: 'contextHelp.matchEnd.a_exportPdf',
      helpId: 'matchend-export-pdf',
      tooltipKey: 'contextHelp.matchEnd.tip_exportPdf'
    },
    {
      questionKey: 'contextHelp.matchEnd.q_downloadJson',
      answerKey: 'contextHelp.matchEnd.a_downloadJson',
      helpId: 'matchend-export-json',
      tooltipKey: 'contextHelp.matchEnd.tip_downloadJson'
    },
    {
      questionKey: 'contextHelp.matchEnd.q_reopenSet',
      answerKey: 'contextHelp.matchEnd.a_reopenSet',
      helpId: 'matchend-reopen-set',
      tooltipKey: 'contextHelp.matchEnd.tip_reopenSet'
    }
  ],

  manualAdjustments: [
    {
      questionKey: 'contextHelp.manualAdjustments.q_editScores',
      answerKey: 'contextHelp.manualAdjustments.a_editScores',
      helpId: 'manual-scores-tab',
      tooltipKey: 'contextHelp.manualAdjustments.tip_editScores'
    },
    {
      questionKey: 'contextHelp.manualAdjustments.q_editTeams',
      answerKey: 'contextHelp.manualAdjustments.a_editTeams',
      helpId: 'manual-teams-tab',
      tooltipKey: 'contextHelp.manualAdjustments.tip_editTeams'
    },
    {
      questionKey: 'contextHelp.manualAdjustments.q_editEvents',
      answerKey: 'contextHelp.manualAdjustments.a_editEvents',
      helpId: 'manual-events-tab',
      tooltipKey: 'contextHelp.manualAdjustments.tip_editEvents'
    },
    {
      questionKey: 'contextHelp.manualAdjustments.q_saveChanges',
      answerKey: 'contextHelp.manualAdjustments.a_saveChanges',
      helpId: 'manual-save-button',
      tooltipKey: 'contextHelp.manualAdjustments.tip_saveChanges'
    }
  ]
}
