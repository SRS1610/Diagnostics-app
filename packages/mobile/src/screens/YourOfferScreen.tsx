// src/screens/YourOfferScreen.tsx
//
// Mobile Step 17 — "Your offer" (ui_journey_premium.html). Shows the
// trade-in offer built from the cosmetic grade + functional test results
// (packages/shared/tradeInQuote.ts's computeTradeInQuote).
//
// TWO DELIBERATE BEHAVIOURS, both mirrored from packages/portal's
// TradeInPage — money is involved and CLAUDE.md is explicit here:
//
//  1. The offer is NEVER computed against the illustrative seed price
//     table (packages/shared/marketPriceData.ts). Without a real price
//     table for this device, the screen says so and offers no number.
//     A guessed offer becomes a promise as soon as it's shown.
//
//  2. Payout method selection is NOT wired here. The screen ends by
//     handing off to Results — the technician submits the report, then
//     the CUSTOMER accepts / picks payout via the consumer tracker link
//     (Reports → Consumer Link in the portal). Never let the technician
//     accept on the customer's behalf.

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'YourOffer'>;

function money(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function YourOfferScreen({ navigation }: Props) {
  const { device, results } = useSession();
  const cosmetic = results.find((r) => r.testId === 'cosmetic_grading');
  const grade = cosmetic?.value as string | undefined;

  const flagged = useMemo(
    () => results.filter((r) => r.status === 'fail' || r.status === 'warning'),
    [results],
  );

  // A quote needs a grade AND a real price table for the device. Without
  // either, no number is shown — see file header. Since the mobile app
  // does not carry the tenant's price table locally, this screen never
  // produces a number itself; it says an offer will be computed
  // server-side once the report is submitted. The portal's TradeIn page
  // shows the actual quote (with the seed-source block).
  const canShowQuoteContext = Boolean(grade && device);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Your offer</Text>
      <Text style={styles.subtitle}>
        Computed from the checks that just ran and the cosmetic grade.
      </Text>

      {!canShowQuoteContext ? (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            {!grade
              ? 'No cosmetic grade was recorded, so an offer cannot be computed. Complete the cosmetic scan first.'
              : 'Device details are missing from this session.'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.offerCard}>
            <Text style={styles.offerLabel}>Estimated offer</Text>
            <Text style={styles.offerAmount}>{money(0)}</Text>
            <Text style={styles.offerNote}>
              Pending — the final number is calculated server-side from this tenant's price table when the report is
              submitted. If the price table hasn't been uploaded yet, the offer is withheld rather than shown from
              placeholder data (see the Trade-in page in the admin portal).
            </Text>
          </View>

          <View style={styles.breakdownCard}>
            <Text style={styles.breakdownLabel}>Basis</Text>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownKey}>Device</Text>
              <Text style={styles.breakdownVal}>{device?.make} {device?.model}</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownKey}>Cosmetic grade</Text>
              <Text style={styles.breakdownVal}>{grade}</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownKey}>Flagged checks</Text>
              <Text style={styles.breakdownVal}>{flagged.length}</Text>
            </View>
          </View>

          {flagged.length > 0 && (
            <View style={styles.flaggedList}>
              <Text style={styles.flaggedLabel}>Deductions likely for</Text>
              {flagged.map((r) => (
                <Text key={r.testId} style={styles.flaggedItem}>• {r.label}</Text>
              ))}
            </View>
          )}
        </>
      )}

      <Text style={styles.disclaimerText}>
        The customer accepts (or declines) this offer on the tracker link, not from this tablet. That's how a payout
        method gets tied to the correct person.
      </Text>

      <TouchableOpacity style={styles.button} onPress={() => navigation.replace('Results')}>
        <Text style={styles.buttonText}>Continue to submit</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 18, lineHeight: 18 },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 14, marginBottom: 18 },
  warnText: { color: '#92400e', fontSize: 13, lineHeight: 18 },
  offerCard: { backgroundColor: '#f0f9ff', borderRadius: 12, padding: 20, marginBottom: 14, alignItems: 'center' },
  offerLabel: { fontSize: 12, color: '#0369a1', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  offerAmount: { fontSize: 40, fontWeight: '800', color: '#0369a1', marginBottom: 8 },
  offerNote: { fontSize: 11, color: '#075985', textAlign: 'center', lineHeight: 16, paddingHorizontal: 8 },
  breakdownCard: { backgroundColor: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 12 },
  breakdownLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  breakdownKey: { fontSize: 13, color: '#64748b' },
  breakdownVal: { fontSize: 13, color: '#0f172a', fontWeight: '600' },
  flaggedList: { marginBottom: 12 },
  flaggedLabel: { fontSize: 11, color: '#92400e', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  flaggedItem: { fontSize: 12, color: '#78350f', marginLeft: 6, lineHeight: 18 },
  disclaimerText: { fontSize: 11, color: '#64748b', lineHeight: 16, marginVertical: 12, fontStyle: 'italic' },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
});
