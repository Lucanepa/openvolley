// Parsing and formatting behind DateField / TimeField / DateTimeField.
import { describe, it, expect } from 'vitest';
import {
  acceptDateInput, acceptTimeInput, addDays, addMonths, clampDate, inRange, isoToDateText,
  joinDateTime, longDayLabel, minuteOptions, monthGrid, monthNames, normalizeTime, nowTime,
  parseDateText, parseIsoDate, parseTimeText, shapeDateText, shapeTimeText, splitDateTime,
  weekdayIndex, weekdayNames,
} from '../dateTime.js';

describe('dates', () => {
  it('shapes typed digits into DD.MM.YYYY; a separator ends a group early', () => {
    expect(shapeDateText('07102026')).toBe('07.10.2026');
    expect(shapeDateText('7.10.2026')).toBe('7.10.2026');
    expect(shapeDateText('7/1/2026')).toBe('7.1.2026');
    expect(shapeDateText('0710')).toBe('07.10');
    expect(shapeDateText('07.')).toBe('07.');
    expect(shapeDateText('a07x10y2026z9')).toBe('07.10.2026');
    expect(shapeDateText('')).toBe('');
  });

  it('takes an ISO date whole (autofill, paste)', () => {
    expect(acceptDateInput('2026-08-01')).toBe('01.08.2026');
    expect(acceptDateInput('0108')).toBe('01.08');
  });

  it('ISO <-> DD.MM.YYYY round trip', () => {
    for (const iso of ['2026-10-07', '1990-02-28', '2024-02-29', '2000-01-01', '2099-12-31']) {
      expect(parseDateText(isoToDateText(iso)).iso).toBe(iso);
    }
    expect(isoToDateText('2026-10-07T20:45:00Z')).toBe('07.10.2026');
    expect(isoToDateText('')).toBe('');
    expect(isoToDateText('07.10.2026')).toBe('');
  });

  it('reads typed text: complete and real dates only', () => {
    expect(parseDateText('7.1.2026')).toEqual({ iso: '2026-01-07', status: 'ok' });
    expect(parseDateText('')).toEqual({ iso: '', status: 'empty' });
    expect(parseDateText('07.10.20')).toEqual({ iso: '', status: 'incomplete' });
    expect(parseDateText('07.')).toEqual({ iso: '', status: 'incomplete' });
    expect(parseDateText('31.02.2026')).toEqual({ iso: '', status: 'invalid' });
    expect(parseDateText('29.02.2025').status).toBe('invalid');
    expect(parseDateText('29.02.2024').status).toBe('ok');
    expect(parseDateText('00.10.2026').status).toBe('invalid');
    expect(parseDateText('12.13.2026').status).toBe('invalid');
    expect(parseDateText('hello').status).toBe('invalid');
  });

  it('min / max: the date is kept, the status says which bound it broke', () => {
    const range = { min: '2026-10-01', max: '2026-10-31' };
    expect(parseDateText('01.10.2026', range)).toEqual({ iso: '2026-10-01', status: 'ok' });
    expect(parseDateText('31.10.2026', range)).toEqual({ iso: '2026-10-31', status: 'ok' });
    expect(parseDateText('30.09.2026', range)).toEqual({ iso: '2026-09-30', status: 'min' });
    expect(parseDateText('01.11.2026', range)).toEqual({ iso: '2026-11-01', status: 'max' });
    expect(inRange('2026-10-15', range.min, range.max)).toBe(true);
    expect(inRange('2026-10-15', '', '')).toBe(true);
    expect(clampDate('2026-09-01', range.min, range.max)).toBe('2026-10-01');
    expect(clampDate('2027-01-01', range.min, range.max)).toBe('2026-10-31');
  });

  it('calendar arithmetic across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30'); // DST switch in Zürich
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-10-07', 12)).toBe('2027-10-07');
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(weekdayIndex('2026-10-05')).toBe(0); // Monday
    expect(weekdayIndex('2026-10-11')).toBe(6); // Sunday
  });

  it('a month grid is 6 weeks, Monday first', () => {
    const days = monthGrid(2026, 10);
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-09-28');
    expect(days.indexOf('2026-10-01')).toBe(3); // Thursday
    expect(days[41]).toBe('2026-11-08');
  });

  it('month and weekday names follow the app language', () => {
    expect(monthNames('en')[9]).toBe('October');
    expect(monthNames('de-CH')[2]).toBe('März');
    expect(monthNames('fr')[1].toLowerCase()).toBe('février');
    expect(monthNames('it')[0].toLowerCase()).toBe('gennaio');
    expect(weekdayNames('en')[0]).toBe('Mon');
    expect(weekdayNames('de')[0]).toBe('Mo');
    expect(longDayLabel('2026-10-07', 'en')).toMatch(/Wednesday.*7.*October.*2026/);
  });
});

describe('times', () => {
  it('shapes typed digits into H:MM / HH:MM', () => {
    expect(shapeTimeText('2045')).toBe('20:45');
    expect(shapeTimeText('930')).toBe('9:30');
    expect(shapeTimeText('0930')).toBe('09:30');
    expect(shapeTimeText('9:3')).toBe('9:3');
    expect(shapeTimeText('20h45')).toBe('20:45');
    expect(shapeTimeText('20.45')).toBe('20:45');
    expect(shapeTimeText('20:')).toBe('20:');
    expect(shapeTimeText('204599')).toBe('20:45');
    expect(acceptTimeInput('18:30:00')).toBe('18:30');
  });

  it('reads typed text: real times only, min / max kept with a status', () => {
    expect(parseTimeText('9:30')).toEqual({ value: '09:30', status: 'ok' });
    expect(parseTimeText('20:47')).toEqual({ value: '20:47', status: 'ok' });
    expect(parseTimeText('')).toEqual({ value: '', status: 'empty' });
    expect(parseTimeText('20:')).toEqual({ value: '', status: 'incomplete' });
    expect(parseTimeText('24:00').status).toBe('invalid');
    expect(parseTimeText('20:60').status).toBe('invalid');
    expect(parseTimeText('07:59', { min: '08:00' })).toEqual({ value: '07:59', status: 'min' });
    expect(parseTimeText('22:01', { max: '22:00' })).toEqual({ value: '22:01', status: 'max' });
    expect(normalizeTime('8:05:00')).toBe('08:05');
    expect(normalizeTime('25:00')).toBe('');
  });

  it('offers every 5 minutes, plus a typed exact minute', () => {
    expect(minuteOptions(5)).toHaveLength(12);
    expect(minuteOptions(5, 47)).toContain(47);
    expect(minuteOptions(15)).toEqual([0, 15, 30, 45]);
    expect(nowTime(5, new Date('2026-10-07T18:47:00Z'))).toBe('20:45'); // Zürich, CEST
  });

  it('date + time split and join like datetime-local', () => {
    expect(splitDateTime('2026-10-07T20:45')).toEqual({ date: '2026-10-07', time: '20:45' });
    expect(splitDateTime('2026-10-07')).toEqual({ date: '2026-10-07', time: '' });
    expect(splitDateTime('')).toEqual({ date: '', time: '' });
    expect(joinDateTime('2026-10-07', '20:45')).toBe('2026-10-07T20:45');
    expect(joinDateTime('2026-10-07', '')).toBe('');
    expect(joinDateTime('', '20:45')).toBe('');
  });
});
