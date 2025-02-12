import { StyleSheet, View, Text, TouchableOpacity, Modal } from 'react-native';
import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { BlockBlobClient } from '@azure/storage-blob';
import {
  AudioRecording,
  useAudioRecorder,
  ExpoAudioStreamModule
} from '@siteed/expo-audio-stream';
import NetInfo from '@react-native-community/netinfo';
import { Audio } from 'expo-av';

const API_BASE_URL = 'https://api.allnighter.ai';

const headers = {
  'Content-Type': 'application/json',
  'accept': 'application/json, text/plain, */*',
  'x-access-token': "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiZjJiZGEwMzYtZDM1Ni00YWI0LWJlNTctZTc5YTI0ZGE2MmM3IiwiZXhwIjoxNzM5OTQ1NzEzLCJqdGkiOiIwYzcyZmJiNy1jYWY3LTRmZTctODIyYy1iODUxNjNiZjE1OGYifQ.7tieicA8t6ASEtmbS9ncXj_ULN7VBiNWnC-CimoAeYQ",
} as const;

interface UploadResponse {
  message: string;
  upload_url: string;
  file_id: string;
  status_code: number;
  workspace_file_id: string;
  workspace_id: string;
  chat_id: string | null;
  filename: string;
  created_at: number;
  file_type: string;
  blob_already_uploaded: boolean;
  already_registered: boolean;
}

interface BlockInfo {
  blockId: string;
  data: string;  // Store base64 data directly
  position: number;
  retryCount: number;
}

// Create an axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  headers,
  validateStatus: (status) => {
    return status < 500;
  }
});

// Add base64 helper functions at the top
const arrayBufferToBase64 = (buffer: ArrayBufferLike): string => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

// Add helper function for block ID generation
const generateBlockId = (index: number): string => {
  // Pad the index to ensure consistent length (max 64 chars after base64)
  const paddedIndex = index.toString().padStart(6, '0');
  // Convert to base64 directly and make it URL-safe
  return btoa(paddedIndex).replace(/[+/=]/g, '_');
};

export default function HomeScreen() {
  const [status, setStatus] = useState('Ready');
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessingButton, setIsProcessingButton] = useState(false);
  const uploadData = useRef<UploadResponse | null>(null);
  const blobClient = useRef<BlockBlobClient | null>(null);
  const currentFilename = useRef<string>('');
  const isOnline = useRef<boolean>(true);
  const blockIds = useRef<string[]>([]);
  const [queuedBlocks, setQueuedBlocks] = useState<number>(0);
  const pendingBlocks = useRef<BlockInfo[]>([]);
  const isProcessingQueue = useRef<boolean>(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;
  const isRecordingComplete = useRef<boolean>(false);

  const {
    startRecording,
    stopRecording,
    durationMs,
    size,
    isRecording,
  } = useAudioRecorder();

  const [audioResult, setAudioResult] = useState<AudioRecording | null>(null);

  // Replace the web-specific network monitoring with NetInfo
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const isConnected = state.isConnected ?? false;
      isOnline.current = isConnected;
      
      if (isConnected) {
        console.log('Network connected - resuming upload...');
        setStatus('Network connected - resuming upload...');
      } else {
        console.log('Network disconnected...');
        setStatus('Network disconnected');
      }
    });

    // Check initial network state
    NetInfo.fetch().then(state => {
      isOnline.current = state.isConnected ?? false;
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Initialize Audio
  useEffect(() => {
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
      } catch (error) {
        console.error('Failed to initialize Audio:', error);
        setStatus('Failed to initialize audio system');
      }
    })();
  }, []);

  // Add cleanup effect for the sound object
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  const processBlockQueue = async () => {
    if (isProcessingQueue.current || !isOnline.current || !blobClient.current) return;

    isProcessingQueue.current = true;
    setIsUploading(true);

    try {
      while (pendingBlocks.current.length > 0) {
        const blockInfo = pendingBlocks.current[0];
        
        if (!isOnline.current) {
          console.log('⚠️ Network offline, pausing upload');
          setStatus(`Upload paused - waiting for network (${pendingBlocks.current.length} blocks queued)`);
          break;
        }

        try {
          const binaryString = atob(blockInfo.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          
          console.log(`⬆️ Uploading block ${blockInfo.position}ms (${bytes.length} bytes)`);
          
          await blobClient.current.stageBlock(
            blockInfo.blockId,
            bytes,
            bytes.length
          );
          
          if (!blockIds.current.includes(blockInfo.blockId)) {
            blockIds.current.push(blockInfo.blockId);
          }
          pendingBlocks.current.shift();
          setQueuedBlocks(pendingBlocks.current.length);
          
          console.log(`✅ Block ${blockInfo.position}ms uploaded (${pendingBlocks.current.length} remaining)`);
          setStatus(`Uploading: ${Math.round(blockInfo.position / 1000)}s (${pendingBlocks.current.length} blocks queued)`);
        } catch (error) {
          console.error(`❌ Error uploading block ${blockInfo.position}ms:`, error);
          blockInfo.retryCount++;
          
          if (blockInfo.retryCount >= MAX_RETRIES) {
            console.error(`⚠️ Max retries reached for block ${blockInfo.position}ms`);
            pendingBlocks.current.shift();
          } else {
            pendingBlocks.current.shift();
            pendingBlocks.current.push(blockInfo);
            const delay = RETRY_DELAY * Math.pow(2, blockInfo.retryCount - 1);
            setStatus(`Upload failed - retrying in ${delay/1000}s (attempt ${blockInfo.retryCount}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (pendingBlocks.current.length === 0) {
        setIsUploading(false);
        console.log(`🎉 All blocks uploaded (${blockIds.current.length} total)`);
        setStatus('Blocks uploaded');
        
        if (isRecordingComplete.current && !showConfirmModal) {
          if (soundRef.current) {
            await soundRef.current.unloadAsync();
            soundRef.current = null;
          }
          setShowConfirmModal(true);
          setStatus('Ready to confirm upload');
        }
      }
    } finally {
      isProcessingQueue.current = false;
    }
  };

  useEffect(() => {
    const processQueueInterval = setInterval(() => {
      if (isOnline.current && pendingBlocks.current.length > 0 && !isProcessingQueue.current) {
        processBlockQueue();
      }
    }, 1000);

    return () => clearInterval(processQueueInterval);
  }, []);

  const handleStartRecording = async () => {
    if (isProcessingButton) return;
    setIsProcessingButton(true);
    isRecordingComplete.current = false;

    try {
      blockIds.current = [];
      
      const { status: permissionStatus } = await ExpoAudioStreamModule.requestPermissionsAsync();
      if (permissionStatus !== 'granted') {
        setStatus('Microphone permission not granted');
        return;
      }

      const now = new Date();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      const year = now.getFullYear();
      
      const rawUploadFilename = `Recording-${month}-${day}-${year}.m4a`;
      const uploadFilename = encodeURIComponent(rawUploadFilename);
      currentFilename.current = rawUploadFilename;

      console.log('📤 Initializing upload session...');
      const response = await api.post('/m/files/audio/upload', {
        filename: uploadFilename,
        file_type: 'audio/m4a'
      });

      if (response.status === 426) {
        setStatus('Error: Please use HTTPS connection');
        return;
      }

      if (!response.data || response.status >= 400) {
        setStatus(`Error: ${response.data?.message || 'Failed to initialize upload'}`);
        return;
      }

      console.log('✅ Upload session initialized');
      uploadData.current = response.data;
      blobClient.current = new BlockBlobClient(response.data.upload_url);

      const startResult = await startRecording({
        interval: 4000,
        enableProcessing: false,
        compression: {
          enabled: true,
          format: 'aac',
          bitrate: 128000
        },
        sampleRate: 48000,
        channels: 1,
        encoding: 'pcm_16bit',
        onAudioStream: async (event) => {
          try {
            const base64Data = typeof event.data === 'string' 
              ? (event.data.split(',')[1] || event.data)
              : arrayBufferToBase64(event.data instanceof ArrayBuffer ? event.data : event.data.buffer);
            
            pendingBlocks.current.push({
              blockId: generateBlockId(event.position),
              data: base64Data,
              position: event.position,
              retryCount: 0
            });
            
            setQueuedBlocks(pendingBlocks.current.length);
            console.log(`📦 Queued block at position ${event.position}ms (${pendingBlocks.current.length} pending)`);
            
            if (isOnline.current && !isProcessingQueue.current) {
              processBlockQueue();
            }
          } catch (error) {
            console.error('Error processing audio block:', error);
          }
        }
      });

      setStatus('Recording...');
    } catch (error: any) {
      console.error('Error starting recording:', error);
      setStatus(`Failed to start recording: ${error.message}`);
    } finally {
      setIsProcessingButton(false);
    }
  };

  const handleStopRecording = async () => {
    if (!isRecording || isProcessingButton) return;
    setIsProcessingButton(true);

    try {
      console.log('Stopping recording...');
      const result = await stopRecording();
      console.log('Recording stopped, setting isRecordingComplete to true');
      setAudioResult(result);
      isRecordingComplete.current = true;
      setStatus('Recording stopped');

      // Log state after setting
      console.log('After stop - isRecordingComplete:', isRecordingComplete.current);
      console.log('After stop - pendingBlocks:', pendingBlocks.current.length);

      if (result && pendingBlocks.current.length === 0) {
        if (soundRef.current) {
          await soundRef.current.unloadAsync();
          soundRef.current = null;
        }
        setShowConfirmModal(true);
      } else {
        setStatus('Waiting for blocks to finish uploading...');
      }
    } catch (error) {
      console.error('Error stopping recording:', error);
      setStatus('Error stopping recording');
    } finally {
      setIsProcessingButton(false);
    }
  };

  // Add an effect to monitor state changes
  useEffect(() => {
    console.log('State changed - isRecordingComplete:', isRecordingComplete.current);
  }, [isRecordingComplete.current]);

  const handlePlayRecording = async () => {
    if (!audioResult?.fileUri) return;
    
    try {
      if (isPlaying && soundRef.current) {
        // If playing, pause the playback
        await soundRef.current.pauseAsync();
        setIsPlaying(false);
      } else {
        if (!soundRef.current) {
          // Load the sound if not already loaded
          const { sound } = await Audio.Sound.createAsync(
            { uri: audioResult.fileUri },
            { shouldPlay: true }
          );
          soundRef.current = sound;
          
          // Add playback status listener
          sound.setOnPlaybackStatusUpdate(async (status) => {
            if (status.isLoaded) {
              setIsPlaying(status.isPlaying);
              // When playback finishes
              if (status.didJustFinish) {
                setIsPlaying(false);
              }
            }
          });
        } else {
          // Resume playback if sound is already loaded
          await soundRef.current.playAsync();
        }
        setIsPlaying(true);
      }
    } catch (error) {
      console.error('Error playing recording:', error);
      setStatus('Error playing recording');
    }
  };

  const handleCancelUpload = async () => {
    // Stop and unload any playing audio
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setIsPlaying(false);
    setShowConfirmModal(false);
    setStatus('Upload cancelled');
  };

  const handleConfirmUpload = async () => {
    if (!uploadData.current || isProcessingButton) {
      setStatus('No recording available or upload in progress');
      return;
    }
    setIsProcessingButton(true);
    setIsUploading(true);

    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      setIsPlaying(false);

      if (blockIds.current.length > 0) {
        console.log('📝 Committing block list...');
        await blobClient.current?.commitBlockList(blockIds.current);
        console.log('✅ Block list committed');
      }

      console.log('📤 Finalizing upload...');
      const doneResponse = await api.post('/files/audio/done', {
        file_id: uploadData.current.file_id,
        filename: currentFilename.current,
        length: Math.round(durationMs / 1000),
        langcode: 'en'
      });

      if (doneResponse.status >= 400) {
        throw new Error(doneResponse.data?.message || 'Failed to mark upload as complete');
      }

      console.log('🎉 Upload completed successfully');
      setStatus('Upload complete!');
      setShowConfirmModal(false);
    } catch (error) {
      console.error('❌ Error finalizing upload:', error);
      setStatus('Error uploading recording');
    } finally {
      setIsProcessingButton(false);
      setIsUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.status}>{status}</Text>
      {size > 0 && (
        <Text style={styles.queueStatus}>
          {`Size: ${size} bytes, Duration: ${Math.round(durationMs / 1000)}s`}
        </Text>
      )}
      {(queuedBlocks > 0 || isUploading) && (
        <View style={styles.queueContainer}>
          <Text style={styles.queueTitle}>Upload Queue</Text>
          <View style={styles.queueInfo}>
            <Text style={styles.queueText}>
              {`Pending Blocks: ${queuedBlocks}`}
            </Text>
            <Text style={styles.queueText}>
              {`Uploaded Blocks: ${blockIds.current.length}`}
            </Text>
            {isProcessingQueue.current && (
              <Text style={[styles.queueText, styles.queueProcessing]}>
                Processing...
              </Text>
            )}
          </View>
          <View style={styles.progressBar}>
            <View 
              style={[
                styles.progressFill,
                { width: `${(blockIds.current.length / (blockIds.current.length + queuedBlocks)) * 100}%` }
              ]} 
            />
          </View>
        </View>
      )}
      <TouchableOpacity
        style={[
          styles.button,
          isRecording && styles.buttonRecording,
          isUploading && styles.buttonUploading,
          isProcessingButton && styles.buttonDisabled
        ]}
        onPress={isRecording ? handleStopRecording : handleStartRecording}
        disabled={isProcessingButton}
      >
        <Text style={styles.buttonText}>
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </Text>
      </TouchableOpacity>

      <Modal
        animationType="fade"
        transparent={true}
        visible={showConfirmModal}
        onRequestClose={() => !isProcessingButton && setShowConfirmModal(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirm Upload</Text>
            <Text style={styles.modalText}>Listen to your recording before uploading:</Text>
            
            <TouchableOpacity
              style={[styles.button, isPlaying && styles.buttonPlaying]}
              onPress={handlePlayRecording}
              disabled={isProcessingButton}
            >
              <Text style={styles.buttonText}>
                {isPlaying ? 'Pause' : 'Play'}
              </Text>
            </TouchableOpacity>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[
                  styles.button,
                  styles.cancelButton,
                  isProcessingButton && styles.buttonDisabled
                ]}
                onPress={handleCancelUpload}
                disabled={isProcessingButton}
              >
                <Text style={styles.buttonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.button,
                  styles.confirmButton,
                  isProcessingButton && styles.buttonDisabled
                ]}
                onPress={handleConfirmUpload}
                disabled={isProcessingButton}
              >
                <Text style={styles.buttonText}>Upload</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  status: {
    marginBottom: 20,
    fontSize: 16,
    color: '#666',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 25,
    marginVertical: 10,
  },
  buttonRecording: {
    backgroundColor: '#FF3B30',
  },
  buttonPlaying: {
    backgroundColor: '#34C759',
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 30,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    width: '80%',
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  modalText: {
    fontSize: 16,
    marginBottom: 20,
    textAlign: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 20,
  },
  cancelButton: {
    backgroundColor: '#8E8E93',
    flex: 1,
    marginRight: 10,
  },
  confirmButton: {
    backgroundColor: '#34C759',
    flex: 1,
    marginLeft: 10,
  },
  queueStatus: {
    marginBottom: 10,
    fontSize: 14,
    color: '#666',
  },
  buttonUploading: {
    backgroundColor: '#FF9500',
  },
  buttonDisabled: {
    opacity: 0.5,
    backgroundColor: '#999',
  },
  queueContainer: {
    width: '100%',
    backgroundColor: '#f5f5f5',
    padding: 15,
    borderRadius: 10,
    marginBottom: 20,
  },
  queueTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  queueInfo: {
    marginBottom: 10,
  },
  queueText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  queueProcessing: {
    color: '#007AFF',
    fontWeight: '500',
  },
  progressBar: {
    height: 6,
    backgroundColor: '#e0e0e0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 3,
  },
});