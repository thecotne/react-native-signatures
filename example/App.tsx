import { useRef, useState } from 'react';
import { Button, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import SignatureView, {
  type SaveFormat,
  type SignatureViewRef,
} from 'react-native-signatures';

const PEN_COLORS = ['black', 'crimson', '#1e40af'];

export default function App() {
  const signatureRef = useRef<SignatureViewRef>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [lastEvent, setLastEvent] = useState('—');
  const [penColorIndex, setPenColorIndex] = useState(0);
  const [preview, setPreview] = useState<{
    base64: string;
    format: SaveFormat;
    label: string;
  } | null>(null);

  const penColor = PEN_COLORS[penColorIndex];

  const save = async (label: string, options?: Parameters<SignatureViewRef['save']>[0]) => {
    try {
      const base64 = await signatureRef.current?.save(options);
      if (base64) {
        setPreview({
          base64,
          format: options?.format ?? 'png',
          label: `${label} · ${Math.round((base64.length * 3) / 4 / 1024)} KB`,
        });
      }
    } catch (error) {
      setLastEvent(`save failed: ${String(error)}`);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <Text style={styles.header}>react-native-signatures</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign here</Text>
          <SignatureView
            ref={signatureRef}
            penColor={penColor}
            backgroundColor="#ffffff"
            style={styles.signature}
            onBegin={() => setLastEvent('onBegin')}
            onEnd={() => setLastEvent('onEnd')}
            onChange={(event) => setIsEmpty(event.nativeEvent.isEmpty)}
          />
          <Text style={styles.status}>
            {isEmpty ? 'empty' : 'has ink'} · last event: {lastEvent} · pen: {penColor}
          </Text>
          <View style={styles.buttonRow}>
            <Button title="Clear" onPress={() => signatureRef.current?.clear()} />
            <Button
              title="Pen color"
              onPress={() => setPenColorIndex((index) => (index + 1) % PEN_COLORS.length)}
            />
          </View>
          <View style={styles.buttonRow}>
            <Button title="Save PNG" onPress={() => save('PNG')} />
            <Button
              title="Trimmed"
              onPress={() => save('PNG · trimmed', { trim: true })}
            />
            <Button
              title="JPEG"
              onPress={() => save('JPEG · white bg', { format: 'jpeg', quality: 0.8 })}
            />
          </View>
        </View>

        {preview && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Exported {preview.label}</Text>
            <Image
              source={{ uri: `data:image/${preview.format === 'jpeg' ? 'jpeg' : 'png'};base64,${preview.base64}` }}
              style={styles.preview}
              resizeMode="contain"
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#eef1f5',
  },
  content: {
    padding: 16,
    gap: 16,
  },
  header: {
    fontSize: 28,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  signature: {
    height: 260,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8a94a6',
  },
  status: {
    fontSize: 13,
    color: '#5b6472',
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  preview: {
    height: 220,
    width: '100%',
    backgroundColor: '#f5f6f8',
    borderRadius: 8,
  },
});
