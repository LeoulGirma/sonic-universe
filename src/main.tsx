import { createRoot } from 'react-dom/client';
import { Stage } from './engine/Stage';
import { Overlay } from './ui/Overlay';
import './ui/styles.css';
import './engine/debug';

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function App() {
  if (!hasWebGL2())
    return (
      <div className="nogl">
        <h1>Sonic Universe needs WebGL 2</h1>
        <p>Open this page in a current version of Chrome, Edge, Firefox or Safari, and check that hardware acceleration is turned on.</p>
      </div>
    );
  return (
    <>
      <Stage />
      <Overlay />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
