import { createRoot } from 'react-dom/client'
import SnapshotMenu from './components/SnapshotMenu'
import './styles/tokens.css'
import './styles/snapshot-menu.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(<SnapshotMenu />)
