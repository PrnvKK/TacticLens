import { render } from 'preact';
import './theatre.css';
import { Gallery } from './Gallery';
import { Theatre } from './Theatre';
import { initGlass } from '../../components/glass';

initGlass();

const q = new URLSearchParams(location.search);
const root = document.getElementById('app');
if (root) render(q.has('gallery') ? <Gallery /> : <Theatre />, root);
