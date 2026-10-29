import { createRoot } from 'react-dom/client'
import SnapshotWindow from './components/SnapshotWindow'
import './styles/tokens.css'
import './styles/snapshot.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(<SnapshotWindow />)
