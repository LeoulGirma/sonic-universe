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
        <p>The browser would not start 3D graphics. After a display change (a TV or second monitor) or a graphics crash, browsers turn 3D off until they are fully closed: close every browser window and open this page again. Otherwise check that hardware acceleration is on, and close other tabs using 3D.</p>
        <p><button className="btn btn--primary" onClick={() => location.reload()}>Try again</button></p>
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
