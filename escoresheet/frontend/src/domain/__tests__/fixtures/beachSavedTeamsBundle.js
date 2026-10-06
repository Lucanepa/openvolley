// docs/beach-saved-teams-spec.md 2.6: the shared beach bundle (verbatim; OpenBeach's tests use the same one).
// A function, so a test may change its copy.
export const beachSavedTeamsBundle = () => JSON.parse(JSON.stringify({
  version: '2026-10-06T08:00:00.000Z', fetched_at: '2026-10-06T08:00:05.000Z', sport: 'beach',
  competitions: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Coop Beachtour', season: '2026', gender: 'women',
      category: 'A1', vm_leagues: [], archived: false, updated_at: '2026-10-06T08:00:00.000Z', sport: 'beach' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Old tour', season: '2025', gender: 'women',
      category: null, vm_leagues: [], archived: true, updated_at: '2026-01-01T00:00:00.000Z', sport: 'beach' }],
  teams: [
    { id: '33333333-3333-4333-8333-333333333333', competition_id: '11111111-1111-4111-8111-111111111111',
      name: 'Müller / Weber', short_name: 'MÜLLER/WEBER', club: 'BC Zürich', color: '#3b82f6',
      svrz_team_name: null, updated_at: '2026-10-06T08:00:00.000Z', sport: 'beach',
      players: [
        { id: '44444444-4444-4444-8444-444444444441', number: 1, first_name: 'Anna', last_name: 'Müller',
          dob: '1998-01-05', license_number: 'B-1', is_libero: false, is_captain: false, active: true,
          sort_order: 0, country: 'CHE' },
        { id: '44444444-4444-4444-8444-444444444442', number: 2, first_name: 'Sara', last_name: 'Weber',
          dob: '1997-03-12', license_number: null, is_libero: false, is_captain: false, active: true,
          sort_order: 1, country: 'CHE' }],
      staff: [{ id: '55555555-5555-4555-8555-555555555555', role: 'Coach', first_name: 'Eva', last_name: 'Kunz',
        dob: null, license_number: null, sort_order: 0 }] },
    { id: '66666666-6666-4666-8666-666666666666', competition_id: '11111111-1111-4111-8111-111111111111',
      name: 'Rossi', short_name: null, club: null, color: null, svrz_team_name: null,
      updated_at: '2026-09-01T00:00:00.000Z', sport: 'beach',
      players: [{ id: '77777777-7777-4777-8777-777777777777', number: 1, first_name: 'Lia', last_name: 'Rossi',
        dob: null, license_number: null, is_libero: false, is_captain: false, active: true,
        sort_order: 0, country: 'ITA' }],
      staff: [] }]
}))

// The fixture plus one indoor competition with one team: what the console's ?sport=all answers.
export const mixedSavedTeamsBundle = () => {
  const b = beachSavedTeamsBundle()
  return {
    ...b,
    sport: 'all',
    competitions: [
      ...b.competitions,
      { id: '88888888-8888-4888-8888-888888888888', name: '2. Liga Damen', season: '2026/27', gender: 'women',
        category: null, vm_leagues: ['2L'], archived: false, updated_at: '2026-10-01T00:00:00.000Z', sport: 'indoor' }
    ],
    teams: [
      ...b.teams,
      { id: '99999999-9999-4999-8999-999999999999', competition_id: '88888888-8888-4888-8888-888888888888',
        name: 'VBC Test', short_name: 'VBC', club: null, color: '#e2001a', svrz_team_name: 'VBC Test D1',
        updated_at: '2026-10-01T00:00:00.000Z', sport: 'indoor',
        players: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number: 7, first_name: 'Ina', last_name: 'Indoor',
          dob: null, license_number: null, is_libero: false, is_captain: true, active: true, sort_order: 0, country: null }],
        staff: [] }
    ]
  }
}
